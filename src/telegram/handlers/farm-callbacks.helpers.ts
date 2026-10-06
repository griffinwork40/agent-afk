/**
 * Shared helpers for the farm-callbacks handler family.
 *
 * Kept in a separate module so the extracted siblings
 * (farm-callbacks.open-pr.ts, farm-callbacks.respawn.ts) can import from here
 * without creating a circular dependency between themselves and the parent
 * farm-callbacks.ts (which already imports from each sibling).
 *
 * @module telegram/handlers/farm-callbacks.helpers
 */

import type { Context } from 'telegraf';

export type LogFn = (...args: unknown[]) => void;

/**
 * Safely acknowledge a Telegram inline-button callback query.
 *
 * Telegram requires exactly one `answerCbQuery` per callback within ~3 s or
 * it shows an error spinner. This wrapper swallows failures so a transient
 * network error never crashes the whole handler.
 */
export async function safeAnswer(ctx: Context, text: string, log: LogFn): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    log('[farm-callback] answerCbQuery failed:', err);
  }
}
