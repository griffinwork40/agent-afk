/**
 * Handler for Telegram `message_reaction` updates.
 *
 * Records 👍 / 👎 reactions on messages the bot sent as `explicit_feedback`
 * votes, mirroring what `src/telegram/handlers/feedback.ts` does for the
 * /good and /bad commands.
 *
 * Rules implemented here (per issue #2443):
 *  - Only thumbs emojis (👍 / 👎) in `new_reaction` that are NOT in
 *    `old_reaction` trigger a vote. Removals (emoji in old, absent in new)
 *    and unchanged reactions add nothing.
 *  - The reacted-to message must appear in the ReactionMap (i.e. the bot sent
 *    it). Reactions on user messages or unmapped / evicted messages are
 *    silently ignored.
 *  - Changing 👍 to 👎 records the newer verdict (explicit feedback overrides
 *    in the store; history preserves the change).
 *
 * @module telegram/handlers/reaction
 */

import type { Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import { upsertVotes } from '../../agent/outcomes/store.js';
import { errorMessage } from '../../utils/errors.js';
import type { ReactionMap } from '../reaction-map.js';

type LogFn = (...args: unknown[]) => void;

const THUMBS_UP = '👍';
const THUMBS_DOWN = '👎';

/**
 * Determine the net-new thumbs verdict from a reaction update.
 *
 * Returns `'good'` if 👍 was added (not already present in old_reaction),
 * `'bad'` if 👎 was added, or `null` if no thumbs change is detected.
 * When both are added simultaneously (unusual but theoretically possible),
 * 👍 wins — the user tapped 👍 last.
 */
export function resolveThumbsVerdict(
  oldEmojis: string[],
  newEmojis: string[],
): 'good' | 'bad' | null {
  const oldSet = new Set(oldEmojis);
  const added = newEmojis.filter((e) => !oldSet.has(e));
  if (added.includes(THUMBS_UP)) return 'good';
  if (added.includes(THUMBS_DOWN)) return 'bad';
  return null;
}

/**
 * Handle a `message_reaction` context from Telegraf.
 *
 * Extracts `old_reaction` and `new_reaction` from the update, resolves the
 * net-new thumbs verdict, looks up the session ID from `map`, and records an
 * `explicit_feedback` vote via `upsertVotes`.
 */
export async function handleMessageReaction(
  ctx: Context<Update.MessageReactionUpdate>,
  map: ReactionMap,
  log: LogFn,
): Promise<void> {
  const update = ctx.update.message_reaction;
  if (!update) return;

  const chatId: number = typeof update.chat === 'object' ? update.chat.id : (update.chat as unknown as number);
  const messageId: number = update.message_id;

  // Collect emoji strings from the reaction type arrays.
  const toEmojis = (reactions: Array<{ type: string; emoji?: string }>): string[] =>
    reactions.flatMap((r) => (r.type === 'emoji' && r.emoji ? [r.emoji] : []));

  const oldEmojis = toEmojis(update.old_reaction ?? []);
  const newEmojis = toEmojis(update.new_reaction ?? []);

  const verdict = resolveThumbsVerdict(oldEmojis, newEmojis);
  if (verdict === null) return; // no net-new thumbs emoji — ignore

  const sessionId = map.get(chatId, messageId);
  if (!sessionId) {
    // Reaction on an unmapped or evicted message — ignore.
    log('[reaction] unmapped message_id', messageId, 'in chat', chatId, '— ignoring');
    return;
  }

  const vote: 1 | -1 = verdict === 'good' ? 1 : -1;
  const label = verdict === 'good' ? 'succeeded' : 'failed';

  try {
    upsertVotes(sessionId, [
      {
        lf: 'explicit_feedback',
        vote,
        strength: 'strong',
        evidence: 'thumbs_reaction',
        observed_at: new Date().toISOString(),
      },
    ]);
    log(`[reaction] recorded ${label} for session ${sessionId} via thumbs reaction`);
  } catch (err) {
    log('[reaction] upsertVotes error:', errorMessage(err));
  }
}
