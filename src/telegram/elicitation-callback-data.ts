/**
 * Wire format for Telegram inline-button callbacks emitted by ask_question
 * elicitation responses.
 *
 * Telegram enforces a hard 64-byte limit on `callback_data`. The shape here is:
 *
 *   `afk:e:<choiceIndex>:<id>`
 *
 * Where:
 *   - `afk:e:` (7 bytes) is the namespace prefix.
 *   - `<choiceIndex>` is the 0-based choice index (integer).
 *   - `<id>` is a unique elicitation identifier.
 *
 * @module telegram/elicitation-callback-data
 */

export const ELICITATION_CALLBACK_PREFIX = 'afk:e:';

/** Hard limit imposed by Telegram on `callback_data`. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** ID grammar: safe alphanumeric + hyphens + underscores, 1-48 chars. */
const ELICITATION_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;

export interface ParsedElicitationCallback {
  id: string;
  choiceIndex: number;
}

/**
 * Build a callback_data string for a given elicitation id + choice index.
 *
 * Throws if the result would exceed Telegram's 64-byte limit or if the id
 * fails the grammar check.
 */
export function buildElicitationCallback(id: string, choiceIndex: number): string {
  if (!ELICITATION_ID_RE.test(id)) {
    throw new Error(`buildElicitationCallback: invalid id ${JSON.stringify(id)}`);
  }
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0) {
    throw new Error(`buildElicitationCallback: choiceIndex must be a non-negative integer, got ${choiceIndex}`);
  }
  const data = `${ELICITATION_CALLBACK_PREFIX}${choiceIndex}:${id}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `buildElicitationCallback: payload ${bytes} bytes exceeds Telegram's ${TELEGRAM_CALLBACK_DATA_MAX_BYTES}-byte limit (id=${id})`,
    );
  }
  return data;
}

/**
 * Parse a `callback_data` string into a structured elicitation callback.
 *
 * Returns `null` for any input that doesn't match the exact shape,
 * has an invalid choice index, or carries an id that fails the grammar.
 *
 * Pure function - no I/O, no exceptions.
 */
export function parseElicitationCallback(data: string | undefined | null): ParsedElicitationCallback | null {
  if (!data) return null;
  if (!data.startsWith(ELICITATION_CALLBACK_PREFIX)) return null;
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;

  const rest = data.slice(ELICITATION_CALLBACK_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 1) return null;

  const indexStr = rest.slice(0, colonIdx);
  const id = rest.slice(colonIdx + 1);

  const choiceIndex = parseInt(indexStr, 10);
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || String(choiceIndex) !== indexStr) {
    return null;
  }

  if (!ELICITATION_ID_RE.test(id)) return null;

  return { id, choiceIndex };
}
