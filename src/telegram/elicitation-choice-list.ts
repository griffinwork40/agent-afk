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

/** The pointer appended to the keyboard message when the choice list is split out. */
const POINTER_SUFFIX = '\n\n(See choices listed above — reply with a button below.)';

/**
 * Decide how to deliver the full choice list without exceeding Telegram's
 * 4096-char limit.
 *
 * When `baseText + bodySuffix` fits, returns `{ preMessages: [], keyboardText: baseText + bodySuffix }`.
 * When it would overflow, chunks the numbered list into pre-messages and
 * returns a pointer as `keyboardText`.
 *
 * Fix (issue #3631, item 1): `keyboardText` (= baseText + POINTER_SUFFIX) is
 * now measured and falls back to `baseText` alone when it would exceed
 * TELEGRAM_MAX_CHARS (a question of ~4040+ chars would otherwise cause the
 * keyboard send to be rejected by Telegram).
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

  // Item 1 fix: measure keyboardText before using it; fall back to baseText
  // alone if question + pointer would exceed TELEGRAM_MAX_CHARS.
  const withPointer = `${baseText}${POINTER_SUFFIX}`;
  const keyboardText = withPointer.length <= TELEGRAM_MAX_CHARS ? withPointer : baseText;

  return { preMessages, keyboardText };
}

/**
 * Pack `lines` into as few strings as possible, each ≤ `maxLen` chars,
 * joining with '\n'.
 *
 * Fix (issue #3631, item 2): a single line longer than `maxLen` is now
 * hard-split at a safe boundary (never inside an HTML entity) and truncated
 * with '…' so every emitted chunk satisfies the limit.
 */
function chunkLines(lines: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (current === '') {
      // Line fits as its own chunk — or needs splitting.
      const splits = splitLongLine(line, maxLen);
      for (let i = 0; i < splits.length; i++) {
        if (i < splits.length - 1) {
          chunks.push(splits[i]!);
        } else {
          current = splits[i]!;
        }
      }
    } else {
      const joined = `${current}\n${line}`;
      if (joined.length <= maxLen) {
        current = joined;
      } else {
        chunks.push(current);
        // Start fresh with this line (may itself need splitting).
        const splits = splitLongLine(line, maxLen);
        for (let i = 0; i < splits.length; i++) {
          if (i < splits.length - 1) {
            chunks.push(splits[i]!);
          } else {
            current = splits[i]!;
          }
        }
      }
    }
  }
  if (current !== '') chunks.push(current);

  return chunks;
}

/**
 * Split a single line that may exceed `maxLen` into chunks each ≤ `maxLen`.
 * Splits are placed outside HTML entities (`&…;`) to avoid breaking them.
 * The last chunk is truncated with '…' when it would still exceed the limit
 * after all safe split points are exhausted.
 */
function splitLongLine(line: string, maxLen: number): string[] {
  if (line.length <= maxLen) return [line];

  const result: string[] = [];
  let remaining = line;

  while (remaining.length > maxLen) {
    // Find the rightmost split point within [0, maxLen) that is not inside
    // an HTML entity.  An entity starts with '&' and ends with ';' (max ~8 chars).
    let splitAt = maxLen;

    // Walk left from maxLen to find a position not inside an entity.
    // We check whether the candidate suffix-start is preceded by an '&'
    // with no intervening ';' (meaning we are mid-entity).
    const ENTITY_MAX_LEN = 9; // longest HTML entity like &amp;, &lt;, etc. + 1 for safety
    const searchStart = Math.max(0, splitAt - ENTITY_MAX_LEN);
    const window = remaining.slice(searchStart, splitAt);
    const ampIdx = window.lastIndexOf('&');
    if (ampIdx !== -1) {
      // Check if entity is unclosed within the window
      const afterAmp = window.slice(ampIdx);
      if (!afterAmp.includes(';')) {
        // We are inside an entity — move split point left to before '&'
        splitAt = searchStart + ampIdx;
      }
    }

    if (splitAt <= 0) {
      // Degenerate: entire prefix is one huge entity — just hard-cut at maxLen-1
      // and append ellipsis.
      result.push(remaining.slice(0, maxLen - 1) + '…');
      remaining = remaining.slice(maxLen - 1);
      continue;
    }

    result.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) result.push(remaining);
  return result;
}
