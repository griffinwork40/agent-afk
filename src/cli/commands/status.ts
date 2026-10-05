import { Command } from 'commander';
import { env } from '../../config/env.js';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import { AgentSession } from '../../agent/session.js';
import { providerForModel } from '../../agent/providers/index.js';
import { statusPanel } from '../render.js';
import { getApiKeyForModel, getModel, getCodexApiKey } from '../shared-helpers.js';
import { resolveCliPermissionMode } from '../config.js';
import { describeCredentialSource, credentialSourceId } from '../auth-wizard.describe-source.js';
import { loadXaiApiKey, loadAnthropicCredential } from '../../agent/auth/credential-resolver.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check agent connection status')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action(async (options: { format: string }) => {
      const spinner = ora('Checking status...').start();

      try {
        const model = getModel();
        const provider = providerForModel(model as string);
        const apiKey = getApiKeyForModel(model as string);

        // Quick test: create and close a session using the resolved provider.
        // Both openai-compatible and anthropic-direct construct synchronously
        // — no real wire call happens before close().
        const isOpenAI = provider === 'openai-compatible' || provider === 'openai-codex';
        const isXai = provider === 'xai' || provider === 'xai-oauth';
        const session = new AgentSession({
          // Use the fastest model per provider for the check.
          // Note: isXai not branched here — session.close() fires immediately
          // and the model string is only used for provider routing, not a live
          // call, so haiku is a safe default for Anthropic and xAI alike.
          model: isOpenAI ? 'gpt-4o-mini' : 'haiku',
          ...(apiKey !== undefined ? { apiKey } : {}),
          maxTurns: 1,
        });

        await session.close();

        spinner.succeed(`${provider} provider reachable`);

        // Effective new-install/default permission mode for the CLI surfaces
        // (afk chat / interactive). Read once; both output formats reflect it
        // instead of hardcoding bypass-on.
        const permissionMode = resolveCliPermissionMode();

        if (options.format === 'json') {
          // Use the Anthropic-only loader so an xAI user with only XAI_API_KEY
          // does not get anthropic.ok: true (getApiKey() is model-routed and
          // would return the xAI key when the active model is xai/xai-oauth).
          const anthropicApiKey = loadAnthropicCredential();
          const codexApiKey = getCodexApiKey();
          const xaiApiKey = loadXaiApiKey();

          // Stable enum from the same precedence walk as the text Auth row
          // (describeCredentialSource), so text and JSON never disagree.
          const anthropicSource: string | null = anthropicApiKey
            ? credentialSourceId()
            : null;

          const codexSource = codexApiKey
            ? env.OPENAI_API_KEY
              ? 'OPENAI_API_KEY'
              : 'CODEX_API_KEY'
            : null;

          const xaiSource: string | null = xaiApiKey ? 'XAI_API_KEY' : null;

          console.log(JSON.stringify({
            providers: {
              anthropic: {
                ok: !!anthropicApiKey,
                source: anthropicSource,
              },
              codex: {
                ok: !!codexApiKey,
                source: codexSource,
              },
              xai: {
                ok: !!xaiApiKey,
                source: xaiSource,
              },
            },
            model: String(model),
            permissionMode,
            bypass: permissionMode === 'bypassPermissions',
          }, null, 2));
        } else {
          const bypassRow = permissionMode === 'bypassPermissions'
            ? { label: 'Permissions', value: 'Bypass — path containment off (read/write anywhere)', kind: 'warn' as const }
            : { label: 'Permissions', value: `Contained — mode: ${permissionMode}`, kind: 'info' as const };
          console.log(
            '\n' +
              statusPanel('Agent AFK · Status', [
                { label: 'Provider', value: provider, kind: 'info' },
                {
                  label: 'Auth',
                  value: isOpenAI
                    ? apiKey
                      ? 'Found (OPENAI_API_KEY / CODEX_API_KEY)'
                      : 'Reading ~/.codex/auth.json (run `afk provider auth diagnose`)'
                    : isXai
                      ? apiKey
                        ? 'Found (XAI_API_KEY)'
                        : 'No XAI_API_KEY set'
                      : apiKey
                        ? `Found (${describeCredentialSource()})`
                        : 'Falling back to Claude OAuth',
                  kind: apiKey ? 'ok' : 'warn',
                },
                { label: 'Model', value: String(model), kind: 'info' },
                bypassRow,
              ]) +
              '\n',
          );
        }
      } catch (error) {
        spinner.fail('Connection failed');
        handleCommandError(error);
      }
    });
}
