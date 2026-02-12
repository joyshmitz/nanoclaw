// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands the agent runs.
export const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Prefix a shell command with `unset` for secret env vars.
 * Returns the original command unchanged if it's empty/falsy.
 */
export function sanitizeBashCommand(command: string): string {
  if (!command) return command;
  return `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; ${command}`;
}
