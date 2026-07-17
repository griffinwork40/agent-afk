import { palette } from './palette.js';
import { getEnvConfigPath } from '../paths.js';
import { upsertEnvVar } from '../utils/envFile.js';
import { promptSecret } from '../utils/prompt-secret.js';

/**
 * Re-export the surface-agnostic `.env` upsert primitive. The canonical home
 * is `src/utils/envFile.ts`; this re-export preserves the original
 * `cli/auth-wizard.upsertEnvVar` import path for existing CLI callers.
 */
export { upsertEnvVar };

/**
 * Prompts the user for an Anthropic API key or OAuth token via stdin.
 *
 * S1 fix: delegates to `promptSecret()` which uses raw-mode with no echo so
 * the token is never written to the terminal, scrollback, or session logs.
 */
export function promptToken(): Promise<string> {
  return promptSecret('Anthropic API key or OAuth token: ');
}

/**
 * Orchestrates the full auth wizard: prompts for a token (or uses a provided
 * one), detects the token type by prefix, saves to the env file, and prints a
 * success message.
 *
 * @param token - Optional pre-supplied token; if omitted, the user is prompted.
 */
export async function runAuthWizard(token?: string): Promise<void> {
  const inputToken = token ?? (await promptToken());
  if (!inputToken) {
    console.error(palette.error('No token provided. Nothing saved.'));
    process.exit(1);
  }

  const envPath = getEnvConfigPath();
  let envVarName: string;
  let keysToRemove: string[];

  if (inputToken.startsWith('sk-ant-oat')) {
    envVarName = 'CLAUDE_CODE_OAUTH_TOKEN';
    keysToRemove = ['ANTHROPIC_API_KEY'];
  } else {
    envVarName = 'ANTHROPIC_API_KEY';
    keysToRemove = ['CLAUDE_CODE_OAUTH_TOKEN'];
  }

  upsertEnvVar(envPath, envVarName, inputToken, keysToRemove);

  console.log(palette.success(`✓ Saved ${envVarName} to ${envPath}`));
  console.log(palette.meta('Restart any running afk daemon to pick up the new token.'));
}
