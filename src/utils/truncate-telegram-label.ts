/**
 * Truncate a Telegram inline-keyboard button label to Telegram's ~64-byte
 * UTF-8 limit.
 *
 * Uses `Buffer` to count bytes correctly for multi-byte code points and slices
 * on UTF-8 boundaries so a multi-byte sequence is never split mid-codepoint.
 * A dangling replacement character (`U+FFFD`) that `TextDecoder` inserts when
 * the truncation falls inside a multi-byte sequence is stripped from the tail.
 *
 * ## Background
 * Button labels are agent-controlled and can exceed 64 bytes.  An overflowing
 * label causes Telegram's `sendMessage` to return a 400 that the caller's
 * `.catch` swallows, silently resolving `decline` — so the truncation must
 * happen before the API call.
 *
 * Previously duplicated in:
 *   - `src/telegram/elicitation-handler.ts`
 *   - `src/telegram/handoff-answer.ts`
 *   - `src/agent/daemon/handoff-wiring.ts`
 *
 * @module utils/truncate-telegram-label
 */

const MAX_TELEGRAM_LABEL_BYTES = 64;

/**
 * Truncate a Telegram button label so its UTF-8 encoding fits within
 * `maxBytes` bytes (default: 64).
 *
 * @param label   The raw button text (may be any length).
 * @param maxBytes Byte ceiling (default 64).
 * @returns The label unchanged when it already fits; otherwise a UTF-8-safe
 *   prefix that fits within `maxBytes` bytes.
 */
export function truncateTelegramLabel(
  label: string,
  maxBytes: number = MAX_TELEGRAM_LABEL_BYTES,
): string {
  if (Buffer.byteLength(label, 'utf8') <= maxBytes) return label;
  const buf = Buffer.from(label, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD$/, '');
}
