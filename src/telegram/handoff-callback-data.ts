/**
 * Wire format for Telegram inline-button callbacks emitted by durable
 * daemon handoff questions.
 *
 * Telegram enforces a hard 64-byte limit on `callback_data`. The shape is:
 *
 *   `afk:h:<choiceIndex>:<taskId>`
 *
 * Where:
 *   - `afk:h:` (6 bytes) is the namespace prefix.
 *   - `<choiceIndex>` is the 0-based choice index (integer).
 *   - `<taskId>` is the daemon task ID (e.g. `q-1716000000000-abc123`).
 *
 * Task IDs are validated by `assertSafeJobId` (`[A-Za-z0-9_-]{1,128}`).
 * With a typical task ID of ~24 chars, the payload is well under 64 bytes.
 *
 * @module telegram/handoff-callback-data
 */

import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from './elicitation-callback-data.js';

export const HANDOFF_CALLBACK_PREFIX = 'afk:h:';

/** Task ID grammar: same as assertSafeJobId in paths.ts. */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface ParsedHandoffCallback {
  taskId: string;
  choiceIndex: number;
}

/**
 * Build a callback_data string for a handoff inline button.
 *
 * Throws if the result exceeds Telegram's 64-byte limit.
 */
export function buildHandoffCallback(taskId: string, choiceIndex: number): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`buildHandoffCallback: invalid taskId ${JSON.stringify(taskId)}`);
  }
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0) {
    throw new Error(`buildHandoffCallback: choiceIndex must be non-negative integer, got ${choiceIndex}`);
  }
  const data = `${HANDOFF_CALLBACK_PREFIX}${choiceIndex}:${taskId}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `buildHandoffCallback: payload ${bytes} bytes exceeds Telegram's ${TELEGRAM_CALLBACK_DATA_MAX_BYTES}-byte limit`,
    );
  }
  return data;
}

/**
 * Parse a handoff callback_data string.
 * Returns null for any input that doesn't match the expected shape.
 */
export function parseHandoffCallback(data: string | undefined | null): ParsedHandoffCallback | null {
  if (!data) return null;
  if (!data.startsWith(HANDOFF_CALLBACK_PREFIX)) return null;
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;

  const rest = data.slice(HANDOFF_CALLBACK_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 1) return null;

  const indexStr = rest.slice(0, colonIdx);
  const taskId = rest.slice(colonIdx + 1);

  const choiceIndex = parseInt(indexStr, 10);
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || String(choiceIndex) !== indexStr) {
    return null;
  }
  if (!TASK_ID_RE.test(taskId)) return null;

  return { taskId, choiceIndex };
}
