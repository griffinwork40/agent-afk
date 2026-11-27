/**
 * Telegram handoff callbacks, limited to 64 UTF-8 bytes:
 * - Current: `afk:h:q:<choiceIndex>:<questionId>` (UUID v4, independent of task ID length).
 * - Legacy: `afk:h:<choiceIndex>:<taskId>` (only for records without a question ID).
 *
 * @module telegram/handoff-callback-data
 */

import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from './elicitation-callback-data.js';

export const HANDOFF_CALLBACK_PREFIX = 'afk:h:';
const QUESTION_MARKER = 'q:';
/** Task ID grammar: same as assertSafeJobId in paths.ts. */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const QUESTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedHandoffCallback =
  | { choiceIndex: number; questionId: string }
  | { choiceIndex: number; taskId: string };

/** Build callback data, or throw if the inputs are invalid or exceed Telegram's limit. */
export function buildHandoffCallback(
  { taskId, questionId }: { taskId: string; questionId?: string },
  choiceIndex: number,
): string {
  if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0) {
    throw new Error(`buildHandoffCallback: choiceIndex must be a non-negative safe integer, got ${choiceIndex}`);
  }
  if (questionId !== undefined ? !QUESTION_ID_RE.test(questionId) : !TASK_ID_RE.test(taskId)) {
    throw new Error(`buildHandoffCallback: invalid ${questionId !== undefined ? 'questionId' : 'taskId'}`);
  }
  const data = questionId !== undefined
    ? `${HANDOFF_CALLBACK_PREFIX}${QUESTION_MARKER}${choiceIndex}:${questionId}`
    : `${HANDOFF_CALLBACK_PREFIX}${choiceIndex}:${taskId}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `buildHandoffCallback: payload ${bytes} bytes exceeds Telegram's ${TELEGRAM_CALLBACK_DATA_MAX_BYTES}-byte limit`,
    );
  }
  return data;
}

/** Parse both formats, rejecting malformed or oversized inputs. */
export function parseHandoffCallback(data: string | undefined | null): ParsedHandoffCallback | null {
  if (!data?.startsWith(HANDOFF_CALLBACK_PREFIX)) return null;
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;

  const rest = data.slice(HANDOFF_CALLBACK_PREFIX.length);
  const scoped = rest.startsWith(QUESTION_MARKER);
  const payload = scoped ? rest.slice(QUESTION_MARKER.length) : rest;
  const colonIdx = payload.indexOf(':');
  if (colonIdx < 1) return null;

  const indexStr = payload.slice(0, colonIdx);
  const choiceIndex = Number(indexStr);
  if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0 || String(choiceIndex) !== indexStr) return null;

  const id = payload.slice(colonIdx + 1);
  if (scoped) return QUESTION_ID_RE.test(id) ? { questionId: id, choiceIndex } : null;
  return TASK_ID_RE.test(id) ? { taskId: id, choiceIndex } : null;
}
