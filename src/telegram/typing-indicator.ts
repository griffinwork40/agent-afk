import type { Context } from 'telegraf';

/**
 * Delay between typing-indicator refreshes. Telegram expires a
 * `sendChatAction('typing')` bubble after ~5s, so we re-arm just under that
 * ceiling. (Telegraf's own `persistentChatAction` uses the same 4000ms default.)
 */
const TYPING_REFRESH_MS = 4000;

/**
 * Show a Telegram "typing…" indicator for the whole duration of `work`, then
 * return its result (rejections propagate unchanged).
 *
 * Contract: the indicator is BEST-EFFORT — a failed chat action (flood-control
 * 429, blocked chat, transient network) must never block or abort the turn, so
 * every send error is swallowed. This is precisely why we do NOT use Telegraf's
 * `ctx.persistentChatAction`: its initial `sendChatAction` is un-guarded and
 * would throw before `work` ran, silently dropping the user's reply. A one-shot
 * action goes stale after ~5s, so we re-send every TYPING_REFRESH_MS.
 *
 * Invariant: the refresh timer is armed before `work` and cleared in `finally`
 * on every exit path (resolve or throw), so no interval outlives the turn.
 */
export async function withTypingIndicator<T>(
  ctx: Context,
  work: () => Promise<T>,
): Promise<T> {
  ctx.sendChatAction('typing').catch(() => {});
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
