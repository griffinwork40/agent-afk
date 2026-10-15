/**
 * Robust JSON extraction from model text.
 *
 * Models frequently wrap JSON in ```json fences or add prose before/after.
 * This module extracts the first balanced JSON object or array and optionally
 * validates it with a Zod schema.
 *
 * @module whatif/json-extract
 */

import { z } from 'zod';

/**
 * Extract the first balanced JSON object `{…}` or array `[…]` from `text`.
 * Handles:
 *   - ` ```json … ``` ` fences (and ` ``` … ``` ` without language tag)
 *   - Prose before/after the JSON
 *   - Nested objects/arrays
 *
 * Returns `undefined` when no parseable JSON is found.
 */
export function extractJson(text: string): unknown {
  // Strip ```json ... ``` or ``` ... ``` fences first, then fall through
  // to the balanced-scan path on the unwrapped content.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : text;

  return findFirstJsonValue(candidate);
}

/**
 * Extract JSON from `text` and validate it against `schema`.
 * Throws a descriptive error if extraction or validation fails.
 */
export function extractJsonAs<T>(text: string, schema: z.ZodType<T>): T {
  const raw = extractJson(text);
  if (raw === undefined) {
    throw new Error(`json-extract: no JSON object or array found in model text`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`json-extract: schema validation failed — ${msg}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan `text` for the first `{` or `[` and return the parsed value of the
 * balanced block. Returns `undefined` on failure.
 */
function findFirstJsonValue(text: string): unknown {
  const start = indexOfFirst(text, ['{', '[']);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = findBalancedClose(text, start, open as '{' | '[', close as '}' | ']');
  if (end === -1) return undefined;

  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return undefined;
  }
}

/** Return the index of the first occurrence of any char in `chars`. */
function indexOfFirst(text: string, chars: string[]): number {
  let earliest = -1;
  for (const c of chars) {
    const idx = text.indexOf(c);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

/**
 * Walk `text` from `start` (which must be `open`) tracking nesting depth,
 * strings, and escape sequences. Returns the index of the matching `close`
 * character, or -1 if the block is unterminated.
 */
function findBalancedClose(
  text: string,
  start: number,
  open: '{' | '[',
  close: '}' | ']',
): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}
