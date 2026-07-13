/**
 * /config and /doctor slash commands.
 *
 * /config — interactive settings menu on a TTY (browse + edit config keys via
 *   arrow keys), with a read-only `view` dump and a scriptable `set` fast-path
 *   that work on every surface. The interactive editor is composed from the
 *   existing overlay primitives (see render/config-menu.ts) — no new TUI stack.
 * /doctor — read-only system health checks (unchanged).
 *
 * Both remain non-destructive to session state and never call process.exit().
 * Output is written via ctx.out so it works identically on every surface (REPL,
 * Telegram, tests). The interactive menu additionally borrows the REPL's live
 * compositor via ctx.getCompositor(); non-TTY surfaces fall back to the dump.
 */

import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { providerForModel } from '../../../agent/providers/index.js';
import { resolveCliPermissionMode } from '../../config.js';
import { runDoctorChecks } from '../../commands/doctor-checks.js';
import { getConfigKeySpec } from '../../../config/settable-keys.js';
import { setConfigValue, RESTART_NOTE } from '../../../config/mutate.js';
import { runConfigMenu, overlaysFromCompositor, defaultIo } from '../../render/config-menu.js';
import type { SlashCommand, SlashContext, Writer } from '../types.js';

// ---------------------------------------------------------------------------
// /config — read-only view (shared by `/config view`, the non-TTY fallback,
// and unknown-argument handling)
// ---------------------------------------------------------------------------

/** Render the resolved-configuration dump (model, provider, keys, env vars). */
function renderConfigView(out: Writer): void {
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
}

// ---------------------------------------------------------------------------
// /config set <key> <value> — scriptable fast-path (agent-tier keys only)
// ---------------------------------------------------------------------------

/**
 * Handle `/config set <key> <value>`. Writes agent-tier config keys directly;
 * refuses human-tier keys (they require the interactive confirm or the CLI) and
 * unknown keys. Works on every surface (no compositor needed).
 */
function handleConfigSet(ctx: SlashContext, rest: string): 'continue' {
  const trimmed = rest.trim();
  const sp = trimmed.indexOf(' ');
  if (sp === -1) {
    ctx.out.warn('Usage: /config set <key> <value>');
    return 'continue';
  }
  const path = trimmed.slice(0, sp).trim();
  const value = trimmed.slice(sp + 1).trim();

  const spec = getConfigKeySpec(path);
  if (!spec) {
    ctx.out.error(`Unknown config key: ${path}  (type /config to browse settings)`);
    return 'continue';
  }
  if (spec.tier === 'human') {
    ctx.out.warn(
      `${path} is human-tier — set it from the interactive menu (/config) or \`afk config set ${path} <value>\`.`,
    );
    return 'continue';
  }
  try {
    const r = setConfigValue(path, value);
    ctx.out.success(`✓ set ${path} = ${String(r.value)} — ${RESTART_NOTE}`);
  } catch (err) {
    ctx.out.error(err instanceof Error ? err.message : String(err));
  }
  return 'continue';
}

// ---------------------------------------------------------------------------
// /config — command
// ---------------------------------------------------------------------------

const configCmd: SlashCommand = {
  name: '/config',
  summary: 'View or edit configuration — interactive settings menu on a TTY',
  usage: '/config [view | set <key> <value>]',
  hint: 'Browse and edit config mid-session in an arrow-key settings menu. `/config view` prints the resolved configuration; `/config set <key> <value>` sets one agent-tier key. Changes apply on the next restart — same store as `afk config`.',
  async handler(ctx, args) {
    const a = args.trim();

    if (a === 'view') {
      renderConfigView(ctx.out);
      return 'continue';
    }
    if (a === 'set' || a.startsWith('set ')) {
      return handleConfigSet(ctx, a === 'set' ? '' : a.slice(4));
    }
    if (a.length > 0 && a !== 'edit' && a !== 'menu') {
      ctx.out.warn(`Unknown argument: ${a}  (usage: /config [view | set <key> <value>])`);
      renderConfigView(ctx.out);
      return 'continue';
    }

    // Interactive menu (no args, or `edit`/`menu`). Requires a live compositor;
    // non-TTY surfaces (Telegram, daemon, tests) fall back to the read-only view.
    const compositor = ctx.getCompositor?.() ?? null;
    if (!compositor) {
      renderConfigView(ctx.out);
      ctx.out.line(
        palette.dim('  Interactive editing needs a TTY. Use `/config set <key> <value>` or `afk config`.'),
      );
      return 'continue';
    }

    // A malformed afk.config.json makes defaultIo().current (getConfigValue)
    // throw MalformedConfigError while the menu renders its key rows. The
    // normal config loader tolerates a bad file by warning and continuing
    // (config/json-tier.ts), and the `/config set` fast-path already catches
    // its own writes — mirror that tolerance here so a bad file degrades to the
    // read-only view with an actionable error instead of escaping dispatch()
    // (registry.ts) into the REPL loop, which has no catch and would tear the
    // session down.
    try {
      await runConfigMenu(overlaysFromCompositor(compositor), defaultIo());
    } catch (err) {
      ctx.out.error(
        `Could not open the settings menu: ${err instanceof Error ? err.message : String(err)}`,
      );
      ctx.out.line(palette.dim('  Showing the read-only view instead:'));
      renderConfigView(ctx.out);
    }
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
