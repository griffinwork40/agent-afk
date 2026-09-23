import { Command } from 'commander';
import { palette } from '../palette.js';
import { providerForModel } from '../../agent/providers/index.js';
import { getModel } from '../shared-helpers.js';
import { promptToken, runAuthWizard } from '../auth-wizard.js';
import {
  loadAnthropicCredential,
  preloadClaudeKeychainOAuth,
} from '../../agent/auth/credential-resolver.js';
import { describeCredentialSource } from '../auth-wizard.describe-source.js';

// Re-export upsertEnvVar so existing tests that import it from this module
// continue to work without modification.
export { upsertEnvVar } from '../../utils/envFile.js';

export { promptToken };

/**
 * `afk login` remains Anthropic-only. OpenAI Codex has its own first-party
 * login flow -- when the resolved provider is Codex we print a short guide
 * pointing at it rather than stashing an OpenAI key in `~/.afk/config/.env`.
 *
 * When no token argument is passed, checks for existing credentials first:
 * - ANTHROPIC_API_KEY env / afk.env
 * - CLAUDE_CODE_OAUTH_TOKEN env / afk.env
 * - Claude Code keychain OAuth (from `claude login`)
 * If any are found, reports "already authenticated" and exits. The user
 * already has working auth and doesn't need to paste a key.
 *
 * Pass `--force` (or supply a token argument) to override existing credentials.
 *
 * Detects token type by prefix:
 * - sk-ant-oat* -> saves as CLAUDE_CODE_OAUTH_TOKEN (Bearer auth)
 * - sk-ant-api* or others -> saves as ANTHROPIC_API_KEY (x-api-key header)
 *
 * When saving one type, removes any stale entries of the other type to prevent conflicts.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command('login [token]')
    .description('Save an Anthropic API key or OAuth token for afk to use')
    .option('--force', 'Override existing credentials even if already authenticated')
    .action(async (token: string | undefined, opts: { force?: boolean }) => {
      const provider = providerForModel(getModel() as string);
      if (provider === 'openai-compatible' || provider === 'openai-codex') {
        console.log(palette.warning('`afk login` is Anthropic-only.'));
        console.log('');
        console.log('For OpenAI-backed models (gpt-*, o1*, o3*, o4*, codex-*), authenticate with one of:');
        console.log(palette.brand('  export OPENAI_API_KEY=sk-proj-...'));
        console.log(palette.meta('  # or: export CODEX_API_KEY=...'));
        console.log(palette.brand('  codex login --api-key sk-proj-...'));
        console.log('');
        console.log(
          palette.meta(
            'Run `afk provider auth diagnose` to see which auth source AFK will use.',
          ),
        );
        console.log(
          palette.meta(
            'To save an Anthropic key for Claude models instead, re-run with AFK_MODEL=sonnet (or similar) first.',
          ),
        );
        return;
      }

      // When no explicit token is passed and --force is not set, check for
      // existing credentials. A user who already ran `claude login` (keychain
      // OAuth) or has ANTHROPIC_API_KEY set should not be prompted to paste a
      // key they don't need.
      if (!token && !opts.force) {
        // Refresh any near-expiry keychain token before checking (same as the
        // first-run detector in src/cli/index.ts).
        await preloadClaudeKeychainOAuth(provider);
        const existing = loadAnthropicCredential();
        if (existing) {
          const source = describeCredentialSource();
          console.log(palette.success(`Already authenticated via ${source}.`));
          console.log('');
          console.log('You\'re good to go -- run `afk chat "hello"` to get started.');
          console.log('');
          console.log(
            palette.meta(
              'To replace this credential, run `afk login --force` or pass a token directly: `afk login <token>`',
            ),
          );
          return;
        }
      }

      await runAuthWizard(token);
    });
}
