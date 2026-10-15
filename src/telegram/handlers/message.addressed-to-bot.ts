/**
 * `addressedToBot` — the pure predicate behind the per-chat "tag-only"
 * response policy. Extracted whole from `message.ts` (over its size
 * baseline); re-exported there so existing importers are unchanged.
 *
 * @module telegram/handlers/message.addressed-to-bot
 */
import type { MessageEntity } from 'telegraf/types';

/**
 * Decide whether a message is "addressed to the bot" for the per-chat tag-only
 * response policy. A message counts as addressed when ANY of:
 *
 *   1. It replies to one of the bot's own messages (`replyFromId === botId`).
 *   2. It carries a `mention` entity whose text is `@<botUsername>` (the entity
 *      text is sliced from `text` at [offset, offset+length) and compared
 *      case-insensitively — Telegram usernames are case-insensitive).
 *   3. It carries a `text_mention` entity (used for users without a public
 *      username) whose `user.id` equals the bot's id.
 *
 * Fail-closed on the mention paths when the inputs needed to evaluate them are
 * missing (no text, no entities, or no known bot username) — those simply don't
 * match, so an un-addressed message stays un-addressed.
 */
export function addressedToBot(
  text: string | undefined,
  entities: MessageEntity[] | undefined,
  replyFromId: number | undefined,
  botId: number,
  botUsername: string | undefined,
): boolean {
  // (a) Reply to one of the bot's own messages.
  if (replyFromId !== undefined && replyFromId === botId) return true;

  if (!entities || entities.length === 0) return false;

  const wantMention = botUsername ? `@${botUsername.toLowerCase()}` : undefined;

  for (const e of entities) {
    // (c) text_mention: discriminated narrowing exposes `user` without a cast.
    if (e.type === 'text_mention') {
      if (e.user?.id === botId) return true;
      continue;
    }
    // (b) mention: the entity text is the @username; compare case-insensitively.
    if (e.type === 'mention' && wantMention && text !== undefined) {
      const mentionText = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (mentionText === wantMention) return true;
    }
  }

  return false;
}
