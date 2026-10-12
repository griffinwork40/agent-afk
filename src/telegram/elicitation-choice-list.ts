/**
 * Full-text choice rendering for Telegram `choice` elicitations.
 *
 * Contract: Telegram inline-button labels are capped at ~64 UTF-8 bytes
 * (`truncateTelegramLabel`), so a long choice is unreadable on its button.
 * When ANY choice exceeds that cap, the full choices are listed (numbered,
 * HTML-escaped) in the message body and every button is numbered to match,
 * so the operator can always read exactly what they are picking. When all
 * choices fit, buttons stay unnumbered and the body is unchanged.
 *
 * @module telegram/elicitation-choice-list
 */

import { escapeHtml } from './formatter.js';
import { truncateTelegramLabel } from '../utils/truncate-telegram-label.js';

const MAX_LABEL_BYTES = 64;

export interface TelegramChoiceRendering {
  /** HTML to append to the message body ('' when every choice fits its button). */
  bodySuffix: string;
  /** Button labels, parallel to `choices`, each within Telegram's byte limit. */
  labels: string[];
}

export function renderTelegramChoices(choices: readonly string[]): TelegramChoiceRendering {
  const overflow = choices.some((c) => Buffer.byteLength(c, 'utf8') > MAX_LABEL_BYTES);
  if (!overflow) {
    return { bodySuffix: '', labels: choices.map((c) => truncateTelegramLabel(c)) };
  }
  const list = choices.map((c, i) => `${i + 1}. ${escapeHtml(c)}`).join('\n');
  return {
    bodySuffix: `\n\n${list}`,
    labels: choices.map((c, i) => truncateTelegramLabel(`${i + 1}. ${c}`)),
  };
}
