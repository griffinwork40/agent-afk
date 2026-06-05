import { Command } from 'commander';
import { env } from '../../config/env.js';
import { palette } from '../palette.js';
import { providerForModel } from '../../agent/providers/index.js';

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('View current configuration')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action((options: { format: string }) => {
      const modelRaw = env.AFK_MODEL ?? env.CLAUDE_MODEL;
      const model = modelRaw ?? 'sonnet';
      const provider = providerForModel(modelRaw);

      const anthropicApiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN;
      const openaiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY;
      const apiKey = provider === 'anthropic' ? anthropicApiKey : openaiKey;

      const anthropicSource = anthropicApiKey
        ? env.ANTHROPIC_API_KEY
          ? 'ANTHROPIC_API_KEY'
          : 'CLAUDE_CODE_OAUTH_TOKEN'
        : null;

      const codexSource = openaiKey
        ? env.OPENAI_API_KEY
          ? 'OPENAI_API_KEY'
          : 'CODEX_API_KEY'
        : null;

      if (options.format === 'json') {
        console.log(JSON.stringify({
          model,
          provider,
          apiKey: {
            present: !!apiKey,
            source: provider === 'anthropic' ? anthropicSource : codexSource,
          },
          thinking: env.AFK_THINKING || null,
          effort: env.AFK_EFFORT || null,
          bypass: true,
          raw_env: {
            AFK_MODEL: env.AFK_MODEL ?? null,
            AFK_THINKING: env.AFK_THINKING ?? null,
            AFK_EFFORT: env.AFK_EFFORT ?? null,
            ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? 'set' : 'unset',
            CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'unset',
            OPENAI_API_KEY: env.OPENAI_API_KEY ? 'set' : 'unset',
            CODEX_API_KEY: env.CODEX_API_KEY ? 'set' : 'unset',
          },
        }, null, 2));
      } else {
        console.log(palette.info('📋 Current Configuration:\n'));

        console.log(`  Model: ${palette.info(modelRaw ? model : model + ' (default)')}`);
        console.log(`  Provider: ${palette.plan(provider)}`);

        if (provider === 'anthropic') {
          console.log(
            `  API Key: ${apiKey ? palette.success('✓ Set (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)') : palette.warning('⚠ Not set — subprocess will fall back to OAuth / keychain')}`,
          );
        } else {
          console.log(
            `  API Key: ${apiKey ? palette.success('✓ Set (OPENAI_API_KEY / CODEX_API_KEY)') : palette.warning('⚠ Not set — falling back to `codex login` state')}`,
          );
        }

        const thinkingVal = env.AFK_THINKING || '(unset — SDK default)';
        console.log(`  Thinking: ${palette.info(thinkingVal)}`);

        const effortVal = env.AFK_EFFORT || '(unset — SDK default)';
        console.log(`  Effort: ${palette.info(effortVal)}`);

        console.log(`  Bypass Permissions: ${palette.warning('true (enabled)')}`);

        console.log(palette.meta('\n  Environment variables:'));
        console.log(palette.meta('    AFK_MODEL - Default model id (canonical; accepts short aliases or full ids)'));
        console.log(palette.meta('    CLAUDE_MODEL - Legacy alias for AFK_MODEL (Claude-only deployments)'));
        console.log(palette.meta('    ANTHROPIC_API_KEY - Anthropic API key (Claude models)'));
        console.log(palette.meta('    CLAUDE_CODE_OAUTH_TOKEN - Anthropic OAuth token (Claude models)'));
        console.log(palette.meta('    OPENAI_API_KEY / CODEX_API_KEY - OpenAI API key (Codex models)'));
        console.log(palette.meta('    AFK_THINKING - Thinking mode (Claude only: adaptive|disabled|enabled:<N>)'));
        console.log(palette.meta('    AFK_EFFORT - Effort level (low|medium|high|xhigh|max)'));
        console.log(palette.meta('    AFK_TIMEOUT_MS - Per-tick daemon session timeout in ms'));
        console.log(palette.meta('    AFK_SESSIONSTART_COOLDOWN_MS - Phase 6 cooldown between sessionstart fires (default 6h)'));
        console.log('');
      }
    });
}
