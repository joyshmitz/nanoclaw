import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  pendingVoice,
  transcribePendingVoice,
  addPendingVoice,
  withTimeout,
  MAX_VOICE_PER_CYCLE,
  MAX_PENDING_VOICE,
  VOICE_TTL_MS,
} from './voice-pipeline.js';
import type { NewMessage } from './types.js';

// Mock transcription module
vi.mock('./transcription.js', () => ({
  transcribeAudio: vi.fn(async (downloadAudio: () => Promise<Buffer>) => {
    await downloadAudio();
    return 'transcribed text';
  }),
}));

// Mock db module
vi.mock('./db.js', () => ({
  updateMessageContent: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: '[Voice Message]',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('transcribePendingVoice', () => {
  beforeEach(() => {
    pendingVoice.clear();
    vi.clearAllMocks();
  });

  it('transcribes a voice message and updates content', async () => {
    const msg = makeMessage();
    const download = vi.fn(async () => Buffer.from('audio'));
    pendingVoice.set('msg-1:group@g.us', {
      downloadAudio: download,
      chatJid: 'group@g.us',
      createdAt: Date.now(),
    });

    await transcribePendingVoice([msg]);

    expect(msg.content).toBe('[Voice: transcribed text]');
    expect(pendingVoice.size).toBe(0);
  });

  it('skips non-voice messages', async () => {
    const msg = makeMessage({ content: 'Hello' });
    await transcribePendingVoice([msg]);
    expect(msg.content).toBe('Hello');
  });

  it('skips messages with no pending entry', async () => {
    const msg = makeMessage();
    await transcribePendingVoice([msg]);
    expect(msg.content).toBe('[Voice Message]');
  });

  it('cleans up pending entry even on error', async () => {
    const msg = makeMessage();
    const download = vi.fn(async () => { throw new Error('network'); });
    pendingVoice.set('msg-1:group@g.us', {
      downloadAudio: download,
      chatJid: 'group@g.us',
      createdAt: Date.now(),
    });

    await transcribePendingVoice([msg]);

    expect(pendingVoice.size).toBe(0);
    expect(msg.content).toBe('[Voice Message]');
  });

  it('skips expired entries', async () => {
    const msg = makeMessage();
    pendingVoice.set('msg-1:group@g.us', {
      downloadAudio: async () => Buffer.from('audio'),
      chatJid: 'group@g.us',
      createdAt: Date.now() - VOICE_TTL_MS - 1000,
    });

    await transcribePendingVoice([msg]);

    expect(msg.content).toBe('[Voice Message]');
    expect(pendingVoice.size).toBe(0);
  });

  it('stops after MAX_VOICE_PER_CYCLE', async () => {
    const messages: NewMessage[] = [];
    for (let i = 0; i < MAX_VOICE_PER_CYCLE + 2; i++) {
      const msg = makeMessage({ id: `msg-${i}` });
      messages.push(msg);
      pendingVoice.set(`msg-${i}:group@g.us`, {
        downloadAudio: async () => Buffer.from('audio'),
        chatJid: 'group@g.us',
        createdAt: Date.now(),
      });
    }

    await transcribePendingVoice(messages);

    const transcribed = messages.filter(m => m.content.startsWith('[Voice:'));
    expect(transcribed.length).toBe(MAX_VOICE_PER_CYCLE);
  });
});

describe('addPendingVoice', () => {
  beforeEach(() => {
    pendingVoice.clear();
  });

  it('adds entry to pendingVoice map', () => {
    addPendingVoice('msg-1', 'group@g.us', async () => Buffer.from('audio'));
    expect(pendingVoice.size).toBe(1);
    expect(pendingVoice.has('msg-1:group@g.us')).toBe(true);
  });

  it('drops oldest when at capacity', () => {
    for (let i = 0; i < MAX_PENDING_VOICE; i++) {
      pendingVoice.set(`old-${i}:group@g.us`, {
        downloadAudio: async () => Buffer.from(''),
        chatJid: 'group@g.us',
        createdAt: Date.now(),
      });
    }
    expect(pendingVoice.size).toBe(MAX_PENDING_VOICE);

    addPendingVoice('new-msg', 'group@g.us', async () => Buffer.from(''));

    expect(pendingVoice.size).toBe(MAX_PENDING_VOICE);
    expect(pendingVoice.has('new-msg:group@g.us')).toBe(true);
    expect(pendingVoice.has('old-0:group@g.us')).toBe(false);
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when promise completes within timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects when promise exceeds timeout', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve('late'), 10_000);
    });

    const promise = withTimeout(slow, 100, 'test');
    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('test timeout (100ms)');
  });
});
