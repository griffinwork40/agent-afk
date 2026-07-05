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
 *   /thinking off        — suppress thinking entirely
 *
 * Mutates `ctx.stats.thinkingUi`, which the REPL loop reads at the top of each
 * turn (`loop-iteration.ts`). No status-line integration — acknowledgment is
 * printed via `ctx.out.success`, matching the `/model` confirmation pattern.
 */

import type { ThinkingUiMode } from '../types.js';
import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';

const VALID_MODES: readonly ThinkingUiMode[] = ['summary', 'live', 'off'];

const MODE_DESCRIPTIONS: Record<ThinkingUiMode, string> = {
  live: 'streaming preview + finalize summary',
  summary: 'collapsed one-line summary on finalize',
  off: 'suppressed entirely',
};

export const thinkingCmd: SlashCommand = {
  name: '/thinking',
  aliases: ['/thinking-ui'],
  usage: '/thinking [summary|live|off]',
  summary: 'Toggle how thinking blocks are rendered mid-session',
  hint:
    'Switch thinking display: `live` (streaming preview + summary, default), ' +
    '`summary` (one-line collapse only), or `off` (hidden). ' +
    'Takes effect on the next turn — same semantics as `/model`. ' +
    'Run without args to see the current mode.',
  flags: ['summary', 'live', 'off'],
  async handler(ctx, args) {
    const target = args.trim().toLowerCase() as ThinkingUiMode;

    // No args → show current mode.
    if (!target) {
      const current = ctx.stats.thinkingUi ?? 'live';
      ctx.out.info(`Thinking display: ${palette.brand(current)} (${MODE_DESCRIPTIONS[current]})`);
      return 'continue';
    }

    // Validate.
    if (!VALID_MODES.includes(target)) {
      ctx.out.warn(
        `Invalid mode: "${target}". Valid modes: ${VALID_MODES.join(', ')}`,
      );
      return 'continue';
    }

    // Mutate the shared stats object — the REPL loop reads
    // `ctx.stats.thinkingUi` at the top of the next turn.
    ctx.stats.thinkingUi = target;
    ctx.out.success(
      `Thinking display set to ${palette.brand(target)} (${MODE_DESCRIPTIONS[target]}). ` +
      `Takes effect on the next turn.`,
    );
    return 'continue';
  },
};