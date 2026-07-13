/**
 * Telegram session-switcher command handlers — /sessions and /new, plus the
 * inline-button switch callback (afk:sw:<sessionId>).
 *
 * Multi-session model: one ACTIVE conversation per chat at a time; every past
 * conversation persists as a resumable sidecar in the shared session store
 * (keyed by telegramChatId). `/sessions` lists them with a tappable button per
 * session; tapping stages a resume (SessionManager.switchToSession) that
 * continues on the next message. `/new` starts a fresh conversation, preserving
 * the current one as resumable. Both refuse while the active session is
 * mid-turn so a streaming reply is never orphaned.
 *
 * @module telegram/handlers/sessions
 */

import { Context, Markup } from 'telegraf';
import { SessionManager } from '../session-manager.js';
import {
  formatError,
  formatSessionsList,
  formatNoSessions,
  formatSwitched,
  formatNewSession,
  formatSessionBusy,
  formatSwitchNotFound,
  formatAlreadyActive,
} from '../formatter.js';

type LogFn = (...args: unknown[]) => void;

/** callback_data prefix for a session-switch inline button (afk:sw:<sessionId>). */
export const SWITCH_CALLBACK_PREFIX = 'afk:sw:';

/** Telegram's hard limit on callback_data (bytes). */
const CALLBACK_DATA_MAX = 64;

/** Read the `data` string off a callback_query context, or '' when absent. */
function callbackData(ctx: Context): string {
  const cq = ctx.callbackQuery;
  return typeof cq === 'object' && cq !== null && 'data' in cq ? (cq as { data: string }).data : '';
}

/** True when the chat has a live session that is NOT idle (mid-turn). */
function isBusy(sessionManager: SessionManager, chatId: number): boolean {
  const live = sessionManager.getSessionIfExists(chatId);
  return live !== undefined && live.state !== 'idle';
}

/**
 * /sessions — list this chat's resumable conversations, newest-active first,
 * with a tappable switch button per session. Read-only: switching happens in
 * the button callback (handleSwitchCallback).
 */
export async function handleSessions(
  ctx: Context,
  sessionManager: SessionManager,
  _log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const sessions = sessionManager.listChatSessions(chatId);
  if (sessions.length === 0) {
    await ctx.reply(formatNoSessions());
    return;
  }

  // One switch button per session whose callback_data fits Telegram's 64-byte
  // cap. SDK session ids are short (UUID-ish), so the guard is belt-and-braces:
  // a pathological id can't throw at send time — that session still shows in the
  // text list, just without a button.
  const buttons = sessions
    .filter((s) => (SWITCH_CALLBACK_PREFIX + s.sessionId).length <= CALLBACK_DATA_MAX)
    .map((s) => [
      Markup.button.callback(
        `${s.active ? '✅ ' : ''}${s.name ?? '(unnamed)'} · ${s.turns} turns`,
        `${SWITCH_CALLBACK_PREFIX}${s.sessionId}`,
      ),
    ]);

  await ctx.reply(formatSessionsList(sessions), {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

/**
 * /new — start a fresh conversation for this chat. The previous one is preserved
 * as a resumable session (/sessions to switch back). Refused while the active
 * session is mid-turn.
 */
export async function handleNew(
  ctx: Context,
  sessionManager: SessionManager,
  registeredCommandChats: Set<number>,
  log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }
  if (isBusy(sessionManager, chatId)) {
    await ctx.reply(formatSessionBusy());
    return;
  }
  try {
    await sessionManager.newSession(chatId);
    // Force per-chat command re-registration for the fresh session (mirrors /clear).
    registeredCommandChats.delete(chatId);
    await ctx.reply(formatNewSession());
  } catch (error) {
    log('New session error:', error);
    await ctx.reply(formatError(error as Error));
  }
}

/**
 * Inline-button callback for /sessions — switch this chat's active conversation
 * to the tapped session. Lazy resume: the target is staged and continues on the
 * next message (SessionManager.switchToSession), so the callback never blocks on
 * a potentially slow resume replay. Refused while the active session is mid-turn.
 *
 * The chat-allowlist check + answerCbQuery are performed by the bot.action
 * wrapper before this is called.
 */
export async function handleSwitchCallback(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const data = callbackData(ctx);
  const targetSessionId = data.startsWith(SWITCH_CALLBACK_PREFIX)
    ? data.slice(SWITCH_CALLBACK_PREFIX.length)
    : '';
  if (!chatId || !targetSessionId) return;

  if (isBusy(sessionManager, chatId)) {
    await ctx.reply(formatSessionBusy());
    return;
  }

  try {
    const res = await sessionManager.switchToSession(chatId, targetSessionId);
    if (!res.ok) {
      await ctx.reply(res.reason === 'already-active' ? formatAlreadyActive() : formatSwitchNotFound());
      return;
    }
    const name = sessionManager
      .listChatSessions(chatId)
      .find((s) => s.sessionId === targetSessionId)?.name;
    const confirm = formatSwitched(name !== undefined ? { name } : {});
    // Edit the /sessions message in place (fall back to a fresh reply).
    await ctx
      .editMessageText(confirm, { parse_mode: 'HTML' })
      .catch(() => ctx.reply(confirm, { parse_mode: 'HTML' }));
  } catch (error) {
    log('Switch callback error:', error);
    await ctx.reply(formatError(error as Error));
  }
}
