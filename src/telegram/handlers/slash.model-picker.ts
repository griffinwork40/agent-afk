/**
 * Inline keyboard for bare `/model` on Telegram. The shared handler prints the
 * current model and aliases; Telegram adds tap-to-switch buttons whose
 * `afk:m:<alias>` callback is handled in bot.ts.
 */
import { Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { isModelAvailable } from '../../agent/auth/model-availability.js';
import { MODEL_ALIASES_HINT } from '../../agent/session/model-slots.js';

export function modelPickerMarkup(): InlineKeyboardMarkup {
  const buttons = MODEL_ALIASES_HINT.map((alias) => [
    Markup.button.callback(isModelAvailable(alias) ? alias : `${alias} — needs sign-in`, `afk:m:${alias}`),
  ]);
  return Markup.inlineKeyboard(buttons).reply_markup;
}
