import { Command } from 'commander';
import chalk from 'chalk';
import { providerForModel } from '../../agent/providers/index.js';
import { getModel } from '../shared-helpers.js';
import { promptToken, runAuthWizard } from '../auth-wizard.js';

// Re-export upsertEnvVar so existing tests that import it from this module
// continue to work without modification.
export { upsertEnvVar } from '../auth-wizard.js';

export { promptToken };

/**
 * `afk login` remains Anthropic-only. OpenAI Codex has its own first-party
 * login flow — when the resolved provider is Codex we print a short guide
 * pointing at it rather than stashing an OpenAI key in `~/.afk/config/.env`.
 *
 * Detects token type by prefix:
 * - sk-ant-oat* → saves as CLAUDE_CODE_OAUTH_TOKEN (Bearer auth)
 * - sk-ant-api* or others → saves as ANTHROPIC_API_KEY (x-api-key header)
 *
 * When saving one type, removes any stale entries of the other type to prevent conflicts.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command('login [token]')
    .description('Save an Anthropic API key or OAuth token for afk to use')
    .action(async (token?: string) => {
      const provider = providerForModel(getModel() as string);
      if (provider === 'openai-compatible' || provider === 'openai-codex') {
        console.log(chalk.yellow('`afk login` is Anthropic-only.'));
        console.log('');
        console.log('For OpenAI-backed models (gpt-*, o1*, o3*, o4*, codex-*), authenticate with one of:');
        console.log(chalk.cyan('  export OPENAI_API_KEY=sk-proj-...'));
        console.log(chalk.cyan('  # or: export CODEX_API_KEY=...'));
        console.log(chalk.cyan('  codex login --api-key sk-proj-...'));
        console.log('');
        console.log(
          chalk.gray(
            'Run `afk provider auth diagnose` to see which auth source AFK will use.',
          ),
        );
        console.log(
          chalk.gray(
            'To save an Anthropic key for Claude models instead, re-run with AFK_MODEL=sonnet (or similar) first.',
          ),
        );
        return;
      }

      await runAuthWizard(token);
    });
}
