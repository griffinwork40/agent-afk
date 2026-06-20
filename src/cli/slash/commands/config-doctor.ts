/**
 * /config and /doctor slash commands — read-only REPL equivalents of the
 * top-level `afk config` and `afk doctor` CLI commands.
 *
 * Both commands are strictly introspective: they never mutate session state
 * and never call process.exit(). Output is written via ctx.out so it works
 * identically on every surface (REPL, Telegram, tests).
 *
 * Reuse strategy:
 *   /config — calls the same env/provider helpers as config-command.ts.
 *   /doctor — calls runDoctorChecks() from doctor-checks.ts, which is also
 *             used by the refactored CLI action in doctor.ts.
 */

import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { providerForModel } from '../../../agent/providers/index.js';
import { resolveCliPermissionMode } from '../../config.js';
import { runDoctorChecks } from '../../commands/doctor-checks.js';
import type { SlashCommand } from '../types.js';

// ---------------------------------------------------------------------------
// /config
// ---------------------------------------------------------------------------

const configCmd: SlashCommand = {
  name: '/config',
  summary: 'View resolved configuration (model, provider, API keys, env vars)',
  hint: 'When you want to confirm which model and API key the session is using, or check what env vars are active — same as `afk config` but available mid-session.',
  async handler(ctx) {
    const { out } = ctx;

    const modelRaw = env.AFK_MODEL ?? env.CLAUDE_MODEL;
    const model = modelRaw ?? 'sonnet';
    const provider = providerForModel(modelRaw);

    const anthropicApiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN;
    const openaiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY;
    const apiKey = provider === 'anthropic' ? anthropicApiKey : openaiKey;

    out.line();
    out.line(palette.bold('Configuration'));
    out.line(divider());

    out.line(`  model       ${palette.info(modelRaw ? model : `${model} (default)`)}`);
    out.line(`  provider    ${palette.plan(provider)}`);

    if (provider === 'anthropic') {
      const keyStatus = apiKey
        ? palette.success('✓ set  (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)')
        : palette.warning('⚠ not set — subprocess falls back to OAuth / keychain');
      out.line(`  api key     ${keyStatus}`);
    } else {
      const openaiSource = env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'CODEX_API_KEY';
      const keyStatus = apiKey
        ? palette.success(`✓ set  (${openaiSource})`)
        : palette.warning('⚠ not set — falling back to `codex login` state');
      out.line(`  api key     ${keyStatus}`);
    }

    out.line(
      `  thinking    ${env.AFK_THINKING ? palette.info(env.AFK_THINKING) : palette.dim('(unset — SDK default)')}`,
    );
    out.line(
      `  effort      ${env.AFK_EFFORT ? palette.info(env.AFK_EFFORT) : palette.dim('(unset — SDK default)')}`,
    );
    const permissionMode = resolveCliPermissionMode();
    out.line(
      `  perm mode   ${permissionMode === 'bypassPermissions'
        ? palette.warning(`${permissionMode} (bypass — containment off)`)
        : palette.info(`${permissionMode} (containment on)`)}`,
    );

    out.line();
    out.line(palette.bold('Environment variables'));
    out.line(divider());

    const envRows: Array<[string, string]> = [
      ['AFK_MODEL', env.AFK_MODEL ?? palette.dim('unset')],
      ['CLAUDE_MODEL', env.CLAUDE_MODEL ?? palette.dim('unset')],
      ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY ? palette.success('set') : palette.dim('unset')],
      ['CLAUDE_CODE_OAUTH_TOKEN', env.CLAUDE_CODE_OAUTH_TOKEN ? palette.success('set') : palette.dim('unset')],
      ['OPENAI_API_KEY', env.OPENAI_API_KEY ? palette.success('set') : palette.dim('unset')],
      ['CODEX_API_KEY', env.CODEX_API_KEY ? palette.success('set') : palette.dim('unset')],
      ['AFK_THINKING', env.AFK_THINKING ?? palette.dim('unset')],
      ['AFK_EFFORT', env.AFK_EFFORT ?? palette.dim('unset')],
    ];
    const keyWidth = Math.max(...envRows.map(([k]) => k.length)) + 2;
    for (const [k, v] of envRows) {
      out.line(`  ${palette.meta(k.padEnd(keyWidth))} ${v}`);
    }
    out.line();

    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// /doctor
// ---------------------------------------------------------------------------

const doctorCmd: SlashCommand = {
  name: '/doctor',
  summary: 'Run system health checks (API keys, directories, config file, Telegram)',
  hint: 'When something feels broken — API key missing, config file unreadable, Telegram bot unreachable. Same checks as `afk doctor` but surfaced mid-session without exiting.',
  async handler(ctx) {
    const { out } = ctx;

    out.line();
    out.line(palette.bold('System health checks'));
    out.line(divider());

    let checks: Awaited<ReturnType<typeof runDoctorChecks>>;
    try {
      checks = await runDoctorChecks();
    } catch (err) {
      out.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    for (const check of checks) {
      let icon: string;
      if (check.state === 'pass') {
        icon = palette.success('✓');
      } else if (check.state === 'warn') {
        icon = palette.warning('⚠');
      } else {
        icon = palette.error('✗');
      }

      let line = `  ${icon} ${check.name}`;
      if (check.detail) {
        line += `  — ${palette.dim(check.detail)}`;
      }
      out.line(line);

      if (check.state !== 'pass' && check.fix) {
        out.line(palette.dim(`      Fix: ${check.fix}`));
      }
    }

    const passed = checks.filter((c) => c.state === 'pass').length;
    const warned = checks.filter((c) => c.state === 'warn').length;
    const failed = checks.filter((c) => c.state === 'fail').length;

    out.line();
    const summaryParts: string[] = [
      palette.success(`${passed} passed`),
      warned > 0 ? palette.warning(`${warned} warned`) : palette.dim(`${warned} warned`),
      failed > 0 ? palette.error(`${failed} failed`) : palette.dim(`${failed} failed`),
    ];
    out.line(`  Summary: ${summaryParts.join(palette.dim('  ·  '))}`);
    out.line();

    return 'continue';
  },
};

export const configDoctorCommands: SlashCommand[] = [configCmd, doctorCmd];
