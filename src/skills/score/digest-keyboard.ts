/**
 * Inline-button keyboard attached to the Telegram farm digest.
 *
 * Layout matches the Day 4b spec:
 *
 *     ✅ Open PR        🔁 Respawn from winner
 *     🔍 Full diff      ❌ Discard all
 *
 * (Row order: actionable on top, destructive bottom-right.)
 *
 * Constraint: this module knows ONLY about the keyboard. It does not import
 * `pushIfConfigured` or any Telegram transport — that lets `digest.ts` keep
 * its lazy-import discipline and lets tests exercise the keyboard shape
 * without touching the network.
 *
 * @module skills/score/digest-keyboard
 */

import type { InlineKeyboardMarkup } from 'telegraf/types';

import { buildFarmCallback } from '../../telegram/farm-callback-data.js';

/**
 * Build the 2×2 inline keyboard for a farm-digest message.
 *
 * @param taskSlug  The farm's `taskSlug` (used as the routing key in every
 *                  button's callback_data). Must match the slug grammar in
 *                  `farm-callback-data.ts` — `buildFarmCallback` throws if not.
 */
export function buildFarmDigestKeyboard(taskSlug: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Open PR', callback_data: buildFarmCallback('p', taskSlug) },
        { text: '🔁 Respawn from winner', callback_data: buildFarmCallback('r', taskSlug) },
      ],
      [
        { text: '🔍 Full diff', callback_data: buildFarmCallback('d', taskSlug) },
        { text: '❌ Discard all', callback_data: buildFarmCallback('x', taskSlug) },
      ],
    ],
  };
}
