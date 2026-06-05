import { Command } from 'commander';
import { env } from '../../config/env.js';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import { AgentSession } from '../../agent/session.js';
import { providerForModel } from '../../agent/providers/index.js';
import { statusPanel } from '../render.js';
import { getApiKeyForModel, getModel, getApiKey, getCodexApiKey } from '../shared-helpers.js';

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
        const session = new AgentSession({
          // Use the fastest model per provider for the check.
          model: isOpenAI ? 'gpt-4o-mini' : 'haiku',
          ...(apiKey !== undefined ? { apiKey } : {}),
          maxTurns: 1,
        });

        await session.close();

        spinner.succeed(`${provider} provider reachable`);

        if (options.format === 'json') {
          const anthropicApiKey = getApiKey();
          const codexApiKey = getCodexApiKey();

          const anthropicSource = anthropicApiKey
            ? env.ANTHROPIC_API_KEY
              ? 'ANTHROPIC_API_KEY'
              : 'CLAUDE_CODE_OAUTH_TOKEN'
            : null;

          const codexSource = codexApiKey
            ? env.OPENAI_API_KEY
              ? 'OPENAI_API_KEY'
              : 'CODEX_API_KEY'
            : null;

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
            },
            model: String(model),
            bypass: true,
          }, null, 2));
        } else {
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
                    : apiKey
                      ? 'Found (ANTHROPIC_API_KEY)'
                      : 'Falling back to Claude OAuth',
                  kind: apiKey ? 'ok' : 'warn',
                },
                { label: 'Model', value: String(model), kind: 'info' },
                { label: 'Bypass', value: 'Permissions disabled', kind: 'warn' },
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
