import { describe, it, expect } from 'vitest';

import { sanitizeBashCommand, SECRET_ENV_VARS } from './sanitize-bash.js';

describe('sanitizeBashCommand', () => {
  const expectedPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;

  it('prefixes a simple command with unset', () => {
    const result = sanitizeBashCommand('ls -la');
    expect(result).toBe(`${expectedPrefix}ls -la`);
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeBashCommand('')).toBe('');
  });

  it('handles command with quotes', () => {
    const cmd = 'echo "hello world"';
    const result = sanitizeBashCommand(cmd);
    expect(result).toBe(`${expectedPrefix}${cmd}`);
  });

  it('handles multiline command', () => {
    const cmd = 'echo line1\necho line2';
    const result = sanitizeBashCommand(cmd);
    expect(result).toBe(`${expectedPrefix}${cmd}`);
  });

  it('includes both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN in unset', () => {
    const result = sanitizeBashCommand('pwd');
    expect(result).toContain('ANTHROPIC_API_KEY');
    expect(result).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
