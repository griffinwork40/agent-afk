/**
 * Shared toggle helper for AFK mode.
 *
 * `toggleAfkMode` is used by the `/afk` slash command and the AFK keybinding in
 * the REPL input loop. It flips the session permission mode
 * (`'autonomous'` <-> `'default'`) and mirrors the result onto
 * `stats.permissionMode` — the value the REPL prompt, status line, and the
 * plan/AFK gate getters all read.
 *
 * AFK ('autonomous') and plan modes are mutually exclusive permission-mode
 * values held in one field, so turning AFK on from plan mode (or vice versa)
 * simply replaces the mode — there is no separate AFK boolean to keep in sync.
 *
 * On turn-ON this helper:
 *   - resets the per-session Telegram push budget (each AFK session starts
 *     fresh — see afk-push.ts), and
 *   - preflights Telegram config: if `TELEGRAM_BOT_TOKEN` or the chat allowlist
 *     is unset it warns (and points at /telegram-setup) but still enters AFK
 *     mode. The posture addendum and the safety gate apply regardless; only the
 *     outbound push silently no-ops until Telegram is configured.
 *
 * If `setPermissionMode` rejects (e.g. the provider's query handle is closing
 * or already torn down), `stats.permissionMode` is left unchanged and the
 * failure is surfaced via `ctx.out.error` so the caller can detect a no-op flip.
 */

import { env } from '../config/env.js';
import { resolveConfiguredNotifyTargets } from '../telegram/notify-routing.js';
import { resetAfkPushBudget } from './commands/interactive/afk-push.js';
import { ensureSessionKey } from '../agent/afk-channel.js';
import { makeLedgerChannelHandler } from '../agent/afk-ledger-channel.js';
import { setPresenceAfk } from '../agent/awareness/presence.js';
import { palette } from './palette.js';
import type { SlashContext } from './slash/types.js';

/** True when Telegram outbound is fully configured (token + ≥1 chat target). */
function isTelegramConfigured(): boolean {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  return resolveConfiguredNotifyTargets().length > 0;
}

export async function toggleAfkMode(
  ctx: SlashContext,
  desired?: boolean,
): Promise<void> {
  const current = ctx.stats.permissionMode === 'autonomous';
  const next = desired !== undefined ? desired : !current;

  try {
    await ctx.session.current.setPermissionMode(next ? 'autonomous' : 'default');
    ctx.stats.permissionMode = next ? 'autonomous' : 'default';
    ctx.ui.repaintStatusLine();
    if (next) {
      resetAfkPushBudget();
      // Bidirectional AFK (scope.lock criterion 1): swap the elicitation handler
      // to the ledger channel so a watching Telegram daemon can answer the
      // agent's questions from the operator's phone — racing the keyboard
      // fallback (invariant #3). Built lazily here because the provider session
      // id is known only after the first turn; if it is not yet available we
      // skip the swap and stay keyboard-only (safe degrade). The channel is
      // bound to the session captured at toggle time.
      const sess = ctx.session.current;
      const id = sess.sessionId;
      const swap = ctx.swapElicitationHandler;
      const fallback = ctx.stdinElicitationHandler;
      if (id && swap && fallback) {
        const ledgerHandler = makeLedgerChannelHandler({
          sessionId: id,
          key: ensureSessionKey(id),
          emitElicitation: (rec) => sess.recordLedgerElicitation(rec.reqId, rec.request),
          fallback,
        });
        swap(ledgerHandler);
        void setPresenceAfk(id, true);
      }
      ctx.out.success(
        palette.info('◐ AFK mode ON') +
        palette.dim(
          ' — autonomous on reversible work; high-risk/irreversible ops are ' +
          'refused; terminal states report to Telegram.',
        ),
      );
      if (!isTelegramConfigured()) {
        ctx.out.error(
          'Telegram is not configured, so AFK updates will not be delivered. ' +
          'Run /telegram-setup to connect a chat. (AFK posture + safety gate ' +
          'still apply.)',
        );
      }
    } else {
      // Restore the stdin elicitation handler (`null` → reinstall stdin) and
      // clear the AFK presence marker so a watching daemon stops tracking.
      ctx.swapElicitationHandler?.(null);
      const id = ctx.session.current.sessionId;
      if (id) void setPresenceAfk(id, false);
      ctx.out.success(
        palette.success('○ AFK mode OFF') + palette.dim(' — default permissions restored'),
      );
    }
  } catch (err) {
    ctx.out.error(
      `Could not toggle AFK mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
