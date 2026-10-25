/**
 * /usage-awareness slash command — toggle whether the model sees usage info.
 *
 * Controls three surfaces:
 *   - The per-round `[vitals]` subscription usage field
 *   - The fan-out notice on `agent`/`compose` dispatch
 *   - The `usage` field in `get_runtime_state`
 *
 * When off, the model has no visibility into how much of the subscription
 * window has been consumed. The operator can still check usage via `/info
 * usage` (human-facing, never injected into model context).
 *
 * Persists to `afk.config.json` as `tools.usageAwareness` so the setting
 * survives across sessions.
 *
 * Usage:
 *   /usage-awareness       — show current state
 *   /usage-awareness on    — model sees usage info (default)
 *   /usage-awareness off   — model does not see usage info
 */

import type { SlashCommand } from '../types.js';
import { palette } from '../../palette.js';
import {
  getUsageAwareness,
  setUsageAwarenessPreference,
} from '../../../agent/session-control/index.js';
import { setConfigValue } from '../../../config/mutate.js';

export const usageAwarenessCmd: SlashCommand = {
  name: '/usage-awareness',
  aliases: ['/ua'],
  usage: '/usage-awareness [on|off]',
  summary: 'Toggle whether the model sees subscription usage info',
  hint:
    'Controls whether subscription usage data appears in the model context ' +
    '(vitals note, fan-out notice, get_runtime_state). When off, the model ' +
    'cannot see how much of your subscription window has been consumed. ' +
    'Human-facing readouts (`/info usage`) are unaffected. Persists across ' +
    'sessions via afk.config.json. Default: on.',
  flags: ['on', 'off'],
  async handler(ctx, args) {
    const target = args.trim().toLowerCase();

    // No args → show current state.
    if (!target) {
      const current = getUsageAwareness(ctx.stats);
      ctx.out.info(
        `Usage awareness: ${palette.brand(current ? 'on' : 'off')} — ` +
        `model ${current ? 'can' : 'cannot'} see subscription usage info`,
      );
      return 'continue';
    }

    // Validate.
    if (target !== 'on' && target !== 'off') {
      ctx.out.warn('Usage: /usage-awareness [on|off]');
      return 'continue';
    }

    const result = setUsageAwarenessPreference(ctx.stats, target);
    if (!result.ok) {
      ctx.out.warn('Usage: /usage-awareness [on|off]');
      return 'continue';
    }

    // Persist to afk.config.json so the setting survives across sessions.
    try {
      await setConfigValue('tools.usageAwareness', result.enabled);
    } catch {
      // Config write is best-effort; the runtime toggle already took effect.
    }

    ctx.ui.repaintStatusLine();
    ctx.out.success(
      `Usage awareness set to ${palette.brand(target)}. ` +
      `The model ${target === 'on' ? 'can' : 'cannot'} see subscription usage info.`,
    );
    return 'continue';
  },
};
