/**
 * Named helper for the /watch command handler registered in TelegramBot.
 * Extracted from bot.ts to keep that file within the 350 code-line ceiling.
 * @module telegram/bot.watch-command
 */

import type { Context } from 'telegraf';
import { SessionWatchManager, resolveWatchTarget, listWatchableSessions } from './watch.js';
import { formatError } from './formatter.js';
import { splitLongMessage } from './formatter.js';
import { sendOptions, type TelegramRoute } from './route.js';

/**
 * Handle the /watch command: list watchable sessions (no arg) or start tailing
 * a named session ledger into the current chat.
 *
 * @param ctx       - Telegraf context for the /watch update
 * @param route     - Resolved route (chatId + optional threadId) for this chat
 * @param watchManager - Shared SessionWatchManager instance
 * @param watchThreadOpts - sendOptions computed for this route (passed in to
 *   avoid recomputing inside the helper; the route is already resolved)
 * @param log       - Bound logger from TelegramBot
 */
export async function handleWatchCommand(
  ctx: Context,
  route: TelegramRoute,
  watchManager: SessionWatchManager,
  watchThreadOpts: ReturnType<typeof sendOptions>,
  log: (...args: unknown[]) => void,
): Promise<void> {
  const { chatId } = route;
  const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? '';
  const arg = text.split(/\s+/).slice(1).join(' ').trim();
  try {
    if (!arg) {
      await ctx.reply(await listWatchableSessions());
      return;
    }
    const sessionId = await resolveWatchTarget(arg);
    if (!sessionId) {
      await ctx.reply(
        `No session ledger found for "${arg}". Use /watch with no argument to list watchable sessions.`,
      );
      return;
    }
    const send = async (msg: string): Promise<void> => {
      for (const part of splitLongMessage(msg)) {
        await ctx.telegram.sendMessage(chatId, part, watchThreadOpts);
      }
    };
    watchManager.start(chatId, sessionId, send);
    await ctx.reply(`📡 Watching ${sessionId} — new activity will stream here. /unwatch to stop.`);
  } catch (error) {
    log('Watch error:', error);
    await ctx.reply(formatError(error as Error));
  }
}
