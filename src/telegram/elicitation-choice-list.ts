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
 * Length safety: Telegram rejects `sendMessage` calls whose text exceeds
 * 4096 characters. When the question + choice list would exceed that limit,
 * `buildChoiceMessages` splits the full list into separate pre-messages (each
 * ≤ 4096 chars) that are sent before the keyboard message, and the keyboard
 * message body is replaced with a pointer. When everything fits, behaviour is
 * unchanged.
 *
 * @module telegram/elicitation-choice-list
 */

import { escapeHtml } from './formatter.js';
import { truncateTelegramLabel } from '../utils/truncate-telegram-label.js';

const MAX_LABEL_BYTES = 64;

/** Telegram's sendMessage character limit. */
export const TELEGRAM_MAX_CHARS = 4096;

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

export interface ChoiceMessages {
  /**
   * Zero or more plain-text messages containing the full choice list,
   * each ≤ TELEGRAM_MAX_CHARS. Must be sent (in order) before the keyboard
   * message. Empty when everything fits in the keyboard message body.
   */
  preMessages: string[];
  /**
   * The text to use as the keyboard message body (replaces the bodySuffix
   * approach when the list has been split out).
   */
  keyboardText: string;
}

/**
 * Decide how to deliver the full choice list without exceeding Telegram's
 * 4096-char limit.
 *
 * When `baseText + bodySuffix` fits, returns `{ preMessages: [], keyboardText: baseText + bodySuffix }`.
 * When it would overflow, chunks the numbered list into pre-messages and
 * returns a pointer as `keyboardText`.
 *
 * @param baseText  The keyboard message body before any choice list is appended
 *                  (i.e. the question text already HTML-escaped).
 * @param rendering Result of `renderTelegramChoices`.
 * @param choices   The original choices array (used to build the pointer line).
 */
export function buildChoiceMessages(
  baseText: string,
  rendering: TelegramChoiceRendering,
  choices: readonly string[],
): ChoiceMessages {
  // No overflow rendering — nothing to split.
  if (rendering.bodySuffix === '') {
    return { preMessages: [], keyboardText: baseText };
  }

  const candidate = baseText + rendering.bodySuffix;
  if (candidate.length <= TELEGRAM_MAX_CHARS) {
    // Fits — use existing inline behaviour.
    return { preMessages: [], keyboardText: candidate };
  }

  // Need to split: build numbered lines and chunk them.
  const lines = choices.map((c, i) => `${i + 1}. ${escapeHtml(c)}`);
  const preMessages = chunkLines(lines, TELEGRAM_MAX_CHARS);
  const keyboardText = `${baseText}\n\n(See choices listed above — reply with a button below.)`;

  return { preMessages, keyboardText };
}

/**
 * Pack `lines` into as few strings as possible, each ≤ `maxLen` chars,
 * joining with '\n'. A single line longer than `maxLen` is emitted as its
 * own chunk (truncation is not applied; Telegram will reject it, but that
 * is a degenerate case outside our scope).
 */
function chunkLines(lines: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (current === '') {
      current = line;
    } else if ((current + '\n' + line).length <= maxLen) {
      current += '\n' + line;
    } else {
      chunks.push(current);
      current = line;
    }
  }
  if (current !== '') chunks.push(current);

  return chunks;
}
