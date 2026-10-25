/**
 * /thinking slash command — toggle the thinking-display mode mid-session.
 *
 * Exposes the boot-time-only `--thinking-ui <summary|live|off>` flag as a
 * runtime slash command so the operator can switch thinking rendering without
 * restarting the REPL. The effect applies on the next turn (the
 * `StreamRenderer` is frozen per-turn — same semantics as `/model`).
 *
 * Usage:
 *   /thinking           — show the current mode
 *   /thinking live       — stream thinking preview + finalize summary (default)
 *   /thinking summary    — collapsed one-line summary on finalize, no live preview
 *   /thinking digest     — live preview + persist a capped reasoning paragraph to scrollback per phase
 *   /thinking off        — suppress thinking entirely
 *
 * Mutates `ctx.stats.thinkingUi`, which the REPL loop reads at the top of each
 * turn (`loop-iteration.ts`). No status-line integration — acknowledgment is
 * printed via `ctx.out.success`, matching the `/model` confirmation pattern.
 */

import type { ThinkingUiMode } from '../types.js';
import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';
import { THINKING_MODES, getSessionThinking, setSessionThinking } from '../../../agent/session-control/index.js';

const MODE_DESCRIPTIONS: Record<ThinkingUiMode, string> = {
  live: 'streaming preview + finalize summary',
  summary: 'collapsed one-line summary on finalize',
  digest: 'live preview + reasoning paragraph persisted to scrollback per phase',
  off: 'suppressed entirely',
};

export const thinkingCmd: SlashCommand = {
  name: '/thinking',
  aliases: ['/thinking-ui'],
  usage: '/thinking [summary|live|digest|off]',
  summary: 'Toggle how thinking blocks are rendered mid-session',
  hint:
    'Switch thinking display: `live` (streaming preview + summary, default), ' +
    '`summary` (one-line collapse only), `digest` (live preview + persists a capped ' +
    'reasoning paragraph to scrollback per phase — good for AFK review), or `off` (hidden). ' +
    'This is a display-only toggle — extended thinking still runs; cost and latency are unaffected. ' +
    'Takes effect on the next turn — same semantics as `/model`. ' +
    'Run without args to see the current mode.',
  flags: ['summary', 'live', 'digest', 'off'],
  async handler(ctx, args) {
    const target = args.trim().toLowerCase() as ThinkingUiMode;

    // No args → show current mode.
    if (!target) {
      const current = getSessionThinking(ctx.stats);
      ctx.out.info(`Thinking display: ${palette.brand(current)} (${MODE_DESCRIPTIONS[current]})`);
      return 'continue';
    }

    // Validate.
    const result = setSessionThinking(ctx.stats, target);
    if (!result.ok) {
      ctx.out.warn(
        `Invalid mode: "${target}". Valid modes: ${THINKING_MODES.join(', ')}`,
      );
      return 'continue';
    }

    ctx.out.success(
      `Thinking display set to ${palette.brand(target)} (${MODE_DESCRIPTIONS[target]}). ` +
      `Takes effect on the next turn. (display only — thinking still runs; cost and latency are unaffected.)`,
    );
    return 'continue';
  },
};