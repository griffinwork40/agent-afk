/**
 * /afk — toggle AFK (away-from-keyboard) mode.
 *
 * Usage:
 *   /afk            — toggle AFK mode on/off
 *   /afk on         — enter AFK mode
 *   /afk off        — exit AFK mode
 *
 * AFK mode is the permission mode `'autonomous'`. It is the orthogonal twin of
 * plan mode: where plan mode restricts the agent (writes refused) so the user
 * can think, AFK mode tells the agent the operator is AWAY and shifts its
 * posture and channel accordingly:
 *
 *   - Posture (system-prompt addendum, `afk-mode-addendum.ts`): work
 *     autonomously on reversible operations; stop at one-way doors and surface
 *     an Asking summary to Telegram rather than guessing.
 *   - Enforcement (hook gate, `afk-mode-gate.ts`): high-risk / irreversible
 *     operations (rm, force-push, reset --hard, writes escaping the workspace,
 *     …) are refused at the hook layer — tree-wide, including subagents —
 *     because raised autonomy without a human watching needs a mechanical
 *     ceiling, not just a prompt.
 *   - Channel (turn-handler + `afk-push.ts`): each turn's terminal state is
 *     pushed to Telegram, scrubbed and rate-limited, so the operator can review
 *     asynchronously.
 *
 * Mutual exclusivity: AFK and plan share the single `permissionMode` field, so
 * `/afk on` from plan mode replaces plan with autonomous (and vice versa).
 *
 * Unlike `/plan off`, `/afk off` seeds no follow-up turn — it simply restores
 * default permissions. Scope: AFK mode is a REPL affordance; other surfaces
 * (Telegram) construct sessions in `'default'` and have no toggle path.
 */

import { toggleAfkMode } from '../../afk-mode-toggle.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

export const afkCmd: SlashCommand = {
  name: '/afk',
  usage: '/afk [on|off]',
  summary: 'Toggle AFK mode — autonomous work + Telegram reporting while you are away',
  hint: 'Tell the agent you are away from keyboard: it works autonomously on reversible operations, a safety gate refuses high-risk/irreversible ops, and each turn reports its terminal state to Telegram. /afk off restores default permissions.',
  async handler(ctx: SlashContext, args: string): Promise<SlashResult> {
    const argLower = args.trim().toLowerCase();
    const desired =
      argLower === 'on' ? true :
      argLower === 'off' ? false :
      ctx.stats.permissionMode !== 'autonomous';

    if (desired && ctx.stats.permissionMode === 'autonomous') {
      // Already on — suppress the no-op success line for ergonomics.
      return 'continue';
    }
    if (!desired && ctx.stats.permissionMode !== 'autonomous') {
      // Already off — surface the affordance with a no-op toggle.
      await toggleAfkMode(ctx, false);
      return 'continue';
    }

    await toggleAfkMode(ctx, desired);
    return 'continue';
  },
};
