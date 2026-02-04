# Гайд для інженера з ШІ

Технічна документація з імплементації AI-агентів на базі NanoClaw та план інтеграції з Odoo 19.

---

## Архітектура NanoClaw

### Компоненти системи

```
┌─────────────────────────────────────────────────────────────────┐
│                         Host (macOS/Linux)                      │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │  WhatsApp   │    │   SQLite     │    │  Task Scheduler  │   │
│  │  (baileys)  │───▶│   Database   │◀───│                  │   │
│  └─────────────┘    └──────────────┘    └──────────────────┘   │
│         │                                        │              │
│         ▼                                        ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Container Runner (src/container-runner.ts)   │  │
│  │              IPC: filesystem (JSON files)                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
└──────────────────────────────│──────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│           Apple Container / Docker (Linux VM)                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │          Claude Agent SDK (agent-runner/src/index.ts)       ││
│  │  ┌─────────────────┐  ┌─────────────┐  ┌────────────────┐  ││
│  │  │ Bash, Read      │  │ WebSearch   │  │ MCP: nanoclaw  │  ││
│  │  │ Write, Edit     │  │ WebFetch    │  │ send_message   │  ││
│  │  │ Glob, Grep      │  │             │  │ schedule_task  │  ││
│  │  └─────────────────┘  └─────────────┘  │ list_tasks     │  ││
│  │                                        │ pause/resume   │  ││
│  │                                        │ cancel_task    │  ││
│  │                                        │ register_group │  ││
│  │                                        └────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Volume Mounts (container-runner.ts:57-167)

| Container Path | Host Path | Режим | Опис |
|----------------|-----------|-------|------|
| `/workspace/project` | `{projectRoot}` | rw | Тільки main — весь проект |
| `/workspace/group` | `groups/{folder}/` | rw | Робоча директорія групи |
| `/workspace/global` | `groups/global/` | ro | Глобальна пам'ять (не main) |
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | rw | Claude sessions |
| `/workspace/ipc` | `data/ipc/{folder}/` | rw | IPC директорія |
| `/workspace/env-dir` | `data/env/` | ro | Filtered env vars |
| Custom mounts | За конфігурацією | rw | Додаткові директорії |

### IPC структура

```
data/ipc/{groupFolder}/
├── messages/           # Вихідні повідомлення від агента
│   └── {timestamp}-{random}.json
├── tasks/              # Команди scheduler (create/pause/resume/cancel)
│   └── {timestamp}-{random}.json
└── current_tasks.json  # Snapshot задач для читання агентом
```

**Atomic write pattern (ipc-mcp.ts:22-34):**
```typescript
function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}
```

---

## Claude Agent SDK

### Виклик агента (agent-runner/src/index.ts:237-258)

```typescript
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

// query() повертає async iterator, не Promise
for await (const message of query({
  prompt,
  options: {
    cwd: '/workspace/group',           // робоча директорія
    resume: input.sessionId,           // продовження сесії (опціонально)
    allowedTools: [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'mcp__nanoclaw__*'               // всі tools з MCP server
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    mcpServers: {
      nanoclaw: ipcMcp                 // MCP server instance
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook()] }]
    }
  }
})) {
  // Обробка повідомлень
  if (message.type === 'system' && message.subtype === 'init') {
    newSessionId = message.session_id;
  }
  if ('result' in message && message.result) {
    result = message.result as string;
  }
}
```

### Параметри options

| Параметр | Тип | Опис |
|----------|-----|------|
| `cwd` | string | Робоча директорія агента |
| `resume` | string | Session ID для продовження контексту |
| `allowedTools` | string[] | Дозволені інструменти |
| `permissionMode` | string | `'bypassPermissions'` для headless |
| `allowDangerouslySkipPermissions` | boolean | Дозвіл обходу permissions |
| `settingSources` | string[] | Джерела налаштувань |
| `mcpServers` | object | MCP сервери |
| `hooks` | object | Hooks (PreCompact, etc.) |

### Session Management

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;      // undefined = нова сесія
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

// Host передає sessionId для продовження контексту
// Agent повертає newSessionId в output
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;   // зберегти для наступного запиту
  error?: string;
}
```

---

## MCP Server (ipc-mcp.ts)

### Створення серверу

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain } = ctx;

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      // tools array
    ]
  });
}
```

### Сигнатура tool() (4 аргументи)

```typescript
tool(
  'tool_name',           // 1. назва
  'Description...',      // 2. опис
  {                      // 3. zod schema (без z.object wrapper)
    param: z.string().describe('...')
  },
  async (args) => {      // 4. handler
    return {
      content: [{ type: 'text', text: 'Result' }]
    };
  }
)
```

### Доступні інструменти

| Tool | Параметри | Опис |
|------|-----------|------|
| `send_message` | `text: string` | Відправка в поточну групу (chatJid з контексту) |
| `schedule_task` | `prompt, schedule_type, schedule_value, context_mode, target_group?` | Планування задачі |
| `list_tasks` | — | Список задач (main: всі, інші: свої) |
| `pause_task` | `task_id: string` | Призупинення |
| `resume_task` | `task_id: string` | Відновлення |
| `cancel_task` | `task_id: string` | Скасування |
| `register_group` | `jid, name, folder, trigger` | Реєстрація групи (тільки main) |

### Приклад: send_message (ipc-mcp.ts:43-67)

```typescript
tool(
  'send_message',
  'Send a message to the current WhatsApp group.',
  {
    text: z.string().describe('The message text to send')
  },
  async (args) => {
    const data = {
      type: 'message',
      chatJid,              // з контексту, не з args!
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString()
    };

    const filename = writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{
        type: 'text',
        text: `Message queued for delivery (${filename})`
      }]
    };
  }
)
```

### Приклад: schedule_task (ipc-mcp.ts:69-147)

```typescript
tool(
  'schedule_task',
  `Schedule a recurring or one-time task...`,
  {
    prompt: z.string().describe('What the agent should do'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().describe('cron: "0 9 * * *" | interval: "300000" | once: "2026-02-01T15:30:00"'),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_group: z.string().optional()  // main only
  },
  async (args) => {
    // Валідація schedule_value
    if (args.schedule_type === 'cron') {
      CronExpressionParser.parse(args.schedule_value);  // throws on invalid
    }

    // Non-main groups can only schedule for themselves
    const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      groupFolder: targetGroup,
      chatJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString()
    };

    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text', text: `Task scheduled` }] };
  }
)
```

---

## Security (mount-security.ts)

### Валідація mounts

```typescript
import { validateAdditionalMounts } from './mount-security.js';

// Сигнатура (container-runner.ts:158-162)
const validatedMounts = validateAdditionalMounts(
  group.containerConfig.additionalMounts,  // масив mount configs
  group.name,                               // назва групи для логування
  isMain                                    // main має більше прав
);
```

### Фільтрація env variables (container-runner.ts:132-136)

```typescript
const allowedVars = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_MODEL',
];
// Тільки ці змінні потрапляють в контейнер
```

---

## Інтеграція з Odoo 19 (ПЛАН ІМПЛЕМЕНТАЦІЇ)

> **ВАЖЛИВО:** Ця інтеграція НЕ РЕАЛІЗОВАНА в NanoClaw. Нижче — план імплементації.

### Варіант 1: MCP Tool для Odoo API

**Файл для створення:** `container/agent-runner/src/odoo-mcp.ts`

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ODOO_URL = process.env.ODOO_URL;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

// Odoo JSON-RPC API
async function odooCall(model: string, method: string, args: unknown[]) {
  const response = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          process.env.ODOO_DB,
          2,  // uid (after authentication)
          ODOO_API_KEY,
          model,
          method,
          args
        ]
      },
      id: Date.now()
    })
  });
  return response.json();
}

export const odooTools = [
  tool(
    'odoo_create_lead',
    'Create a new lead in Odoo CRM',
    {
      name: z.string().describe('Lead name'),
      email: z.string().optional(),
      phone: z.string().optional(),
      description: z.string().optional()
    },
    async (args) => {
      const result = await odooCall('crm.lead', 'create', [{
        name: args.name,
        email_from: args.email,
        phone: args.phone,
        description: args.description
      }]);
      return {
        content: [{ type: 'text', text: `Lead created: ID ${result.result}` }]
      };
    }
  ),

  tool(
    'odoo_search_tasks',
    'Search tasks in Odoo Project',
    {
      project_name: z.string().optional(),
      assignee: z.string().optional(),
      stage: z.string().optional()
    },
    async (args) => {
      const domain: [string, string, unknown][] = [];
      if (args.project_name) {
        domain.push(['project_id.name', 'ilike', args.project_name]);
      }
      if (args.stage) {
        domain.push(['stage_id.name', '=', args.stage]);
      }

      const result = await odooCall('project.task', 'search_read', [
        domain,
        ['name', 'project_id', 'stage_id', 'user_ids', 'date_deadline']
      ]);
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result, null, 2) }]
      };
    }
  )
];
```

### Варіант 2: Webhook Receiver (потребує HTTP сервера)

**Файл для створення:** `src/webhook-server.ts`

```typescript
import express from 'express';
import { sendWhatsAppMessage } from './whatsapp.js';
import { logger } from './logger.js';

const app = express();
app.use(express.json());

// Odoo webhook endpoint
app.post('/webhook/odoo', async (req, res) => {
  const { event, data } = req.body;

  logger.info({ event, data }, 'Received Odoo webhook');

  switch (event) {
    case 'lead.created':
      await sendWhatsAppMessage(
        process.env.MANAGER_GROUP_JID!,
        `Новий лід: ${data.name}\nEmail: ${data.email_from || 'N/A'}`
      );
      break;

    case 'task.assigned':
      await sendWhatsAppMessage(
        data.assignee_phone,  // потрібен mapping phone → JID
        `Вам призначено задачу: ${data.name}`
      );
      break;
  }

  res.json({ received: true });
});

export function startWebhookServer(port: number) {
  app.listen(port, () => {
    logger.info({ port }, 'Webhook server started');
  });
}
```

**Налаштування в Odoo Studio:**

1. Studio → Automated Actions → Create
2. Model: `crm.lead`
3. Trigger: On Creation
4. Action Type: Execute Python Code:

```python
import requests
requests.post('https://your-domain.com/webhook/odoo', json={
    'event': 'lead.created',
    'data': {
        'id': record.id,
        'name': record.name,
        'email_from': record.email_from,
        'phone': record.phone
    }
})
```

### Кроки імплементації

1. [ ] Додати Odoo credentials в `.env`
2. [ ] Створити `odoo-mcp.ts` з tools
3. [ ] Додати tools в `createIpcMcp()`
4. [ ] (Опціонально) Додати webhook server
5. [ ] Налаштувати Odoo Automated Actions
6. [ ] Тестування

---

## Logging (pino)

```typescript
import { logger } from './logger.js';

// Levels: trace, debug, info, warn, error, fatal
logger.info({ group: group.name, duration }, 'Container completed');
logger.error({ error: err.message }, 'Container failed');
logger.debug({ mounts }, 'Container mount configuration');
```

---

## Джерела

**NanoClaw (верифіковано з кодом):**
- `container/agent-runner/src/index.ts` — Claude Agent SDK query()
- `container/agent-runner/src/ipc-mcp.ts` — MCP tools
- `src/container-runner.ts` — mounts, container spawn
- `src/mount-security.ts` — валідація mounts

**Odoo 19 (офіційна документація):**
- [External API (JSON-RPC)](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)
- [Automated Actions](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html)
- [AI Agents](https://www.odoo.com/documentation/19.0/applications/productivity/ai/agents.html)
