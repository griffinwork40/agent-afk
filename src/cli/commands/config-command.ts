/**
 * `afk config` command group — view + edit AFK configuration.
 *
 *   afk config                      — human-readable view of effective config
 *   afk config get [key]            — read afk.config.json (one dotted key or all)
 *   afk config set <key> <value>    — write an afk.config.json key
 *   afk config unset <key>          — remove an afk.config.json key
 *   afk config env get [key]        — read afk.env (one var or all present)
 *   afk config env set <key> [val]  — write an afk.env var (secrets prompted, masked)
 *   afk config env unset <key>      — remove an afk.env var
 *
 * All edits funnel through the validated mutation engine (`src/config/mutate.ts`),
 * which enforces the sensitivity tiers. This CLI is the HUMAN surface, so it
 * passes the `allowSecret`/`allowHumanOnly` gates — secrets are entered via a
 * masked TTY prompt (`promptSecret`) or `--stdin`, never as a positional arg, so
 * the raw value never lands in argv / shell history. (The agent's sanctioned
 * path is the `config_set` tool, which never opts past those gates.)
 *
 * @module cli/commands/config-command
 */

import { Command } from 'commander';
import { env } from '../../config/env.js';
import { palette } from '../palette.js';
import { providerForModel } from '../../agent/providers/index.js';
import { resolveCliPermissionMode } from '../config.js';
import { errorMessage } from '../../utils/errors.js';
import {
  setConfigValue,
  unsetConfigValue,
  getConfigValue,
  listConfig,
  RESTART_NOTE,
} from '../../config/mutate.js';
import { registerEnvSubcommands } from './config-command.env.js';

/** Print an error and set a nonzero exit code (2 = bad input / refused). */
function fail(message: string): void {
  console.error(palette.warning(`✗ ${message}`));
  process.exitCode = 2;
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('View or edit AFK configuration (afk.config.json + afk.env)')
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

      // Effective CLI permission mode (afk chat / interactive). New-install
      // default is bypass; an afk.config.json `permissionMode` key overrides.
      const permissionMode = resolveCliPermissionMode();
      const bypassEnabled = permissionMode === 'bypassPermissions';

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
          permissionMode,
          bypass: bypassEnabled,
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

        console.log(
          `  Permission Mode: ${bypassEnabled
            ? palette.warning(`${permissionMode} (bypass — path containment off)`)
            : palette.info(`${permissionMode} (path containment on)`)}`,
        );

        console.log(palette.meta('\n  Edit config:'));
        console.log(palette.meta('    afk config set permissionMode default  # re-enable path containment'));
        console.log(palette.meta('    afk config set <key> <value>      e.g. afk config set model opus'));
        console.log(palette.meta('    afk config env set <KEY> [value]  e.g. afk config env set AFK_EFFORT high'));
        console.log(palette.meta('    afk config get [key] / afk config env get [key]'));
        console.log('');
      }
    });

  // ── afk.config.json subcommands ──────────────────────────────────────────
  config
    .command('get [key]')
    .description('Read afk.config.json — a dotted key (e.g. telegram.notify.mode) or the whole file')
    .option('--json', 'Output JSON')
    .action((key: string | undefined, opts: { json?: boolean }) => {
      try {
        if (key) {
          const v = getConfigValue(key);
          if (opts.json) console.log(JSON.stringify(v));
          else console.log(v.value === undefined ? palette.meta('(unset)') : String(JSON.stringify(v.value)));
        } else {
          const all = listConfig();
          console.log(JSON.stringify(all, null, 2));
        }
      } catch (err) {
        fail(errorMessage(err));
      }
    });

  config
    .command('set <key> <value>')
    .description('Set an afk.config.json key (dotted path; agent + human-tier keys)')
    .option('--json', 'Output JSON')
    .action((key: string, value: string, opts: { json?: boolean }) => {
      try {
        const r = setConfigValue(key, value, { allowHumanOnly: true });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...r }));
        else console.log(palette.success(`✓ ${r.path} = ${JSON.stringify(r.value)} → ${r.persistedTo}\n  ${RESTART_NOTE}.`));
      } catch (err) {
        fail(errorMessage(err));
      }
    });

  config
    .command('unset <key>')
    .description('Remove an afk.config.json key')
    .option('--json', 'Output JSON')
    .action((key: string, opts: { json?: boolean }) => {
      try {
        const r = unsetConfigValue(key, { allowHumanOnly: true });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...r }));
        else console.log(r.removed ? palette.success(`✓ removed ${r.path} → ${r.persistedTo}`) : palette.meta(`(${r.path} was not set)`));
      } catch (err) {
        fail(errorMessage(err));
      }
    });

  // ── afk.env subcommands ──────────────────────────────────────────────────
  const envCmd = config.command('env').description('View or edit afk.env environment variables');
  registerEnvSubcommands(envCmd);
}
