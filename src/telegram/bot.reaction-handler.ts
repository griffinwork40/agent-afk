/**
 * Wire the `message_reaction` handler onto a Telegraf bot instance.
 *
 * Extracted from bot.ts to keep TelegramBot.setupHandlers() under the
 * 200-line function ceiling. Registers the Telegraf `on('message_reaction')`
 * listener that delegates to `handleMessageReaction`.
 *
 * Telegram only delivers `message_reaction` updates when the update type is
 * explicitly requested in `allowedUpdates`. The bot's `launch()` call in
 * bot.ts must include `'message_reaction'` in that list for this handler to
 * receive anything.
 *
 * Admin note: in Telegram groups the bot must be an admin (or have the
 * "can_read_all_group_messages" flag) to receive reactions on group messages.
 * In private chats and channels no special privileges are needed.
 *
 * @module telegram/bot.reaction-handler
 */

import type { Telegraf, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import { handleMessageReaction } from './handlers/reaction.js';
import { reactionMap } from './reaction-map.js';

type LogFn = (...args: unknown[]) => void;

/**
 * Register the `message_reaction` listener on `bot`.
 *
 * Call once during TelegramBot.setupHandlers(), after the allowlist middleware
 * is installed so unauthorized chats are already filtered before this runs.
 */
export function registerReactionHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: Telegraf<any>,
  log: LogFn,
): void {
  bot.on('message_reaction', (ctx: Context<Update.MessageReactionUpdate>) =>
    handleMessageReaction(ctx, reactionMap, log),
  );
}

/**
 * The update types the bot must request when polling so that Telegraf receives
 * the full set of updates (reactions included). Telegram's default omits
 * `message_reaction`; the explicit list below re-adds the types Telegram would
 * include by default plus the two reaction types.
 *
 * Reference: https://core.telegram.org/bots/api#getupdates
 * Default types (when allowed_updates is empty): message, edited_message,
 * channel_post, edited_channel_post, inline_query, chosen_inline_result,
 * callback_query, shipping_query, pre_checkout_query, poll, poll_answer,
 * my_chat_member, chat_member, chat_join_request.
 */
export const ALLOWED_UPDATE_TYPES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'message_reaction',
  'message_reaction_count',
] as const;
