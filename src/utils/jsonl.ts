/**
 * Shared JSONL (newline-delimited JSON) parsing utilities.
 *
 * The line-by-line JSONL parse pattern (split → trim → skip empty →
 * JSON.parse → catch → optional type-narrow) was previously duplicated in
 * 7+ files across the codebase. This module provides a single canonical
 * implementation that all callers share.
 *
 * Design principles:
 *   - Tolerant by default: malformed lines are skipped, not thrown. This
 *     mirrors the contract every call-site had independently.
 *   - Generic: callers supply an optional type guard to filter/narrow the
 *     parsed values to a concrete type. Without a guard every successfully
 *     parsed value is returned as `unknown`.
 *   - Observable: an optional `onParseError` callback lets callers count,
 *     log, or react to parse failures without losing the skip-on-error
 *     contract.
 *
 * @module utils/jsonl
 */

/** Options for {@link parseJsonlLines}. */
export interface ParseJsonlOptions<T> {
  /**
   * Optional type guard. When provided, only values for which
   * `guard(parsed)` returns `true` are included in the output array.
   * Values that pass `JSON.parse` but fail the guard are silently dropped
   * (they are not delivered to `onParseError`).
   */
  guard?: (x: unknown) => x is T;
  /**
   * Optional callback invoked for every non-empty line that fails
   * `JSON.parse`. Receives the trimmed source line. Useful for counting
   * malformed lines or emitting a debug log without breaking the
   * tolerant-skip contract.
   */
  onParseError?: (trimmedLine: string) => void;
}

/**
 * Parse a raw JSONL string into an array of typed values.
 *
 * Steps for each line:
 *   1. Trim whitespace.
 *   2. Skip blank lines.
 *   3. Attempt `JSON.parse`. On failure, call `options.onParseError` (if
 *      provided) and skip the line.
 *   4. If `options.guard` is provided and returns `false`, skip the value.
 *   5. Otherwise push the parsed value into the result array.
 *
 * Never throws — every failure path is a skip.
 *
 * @typeParam T - The element type of the returned array. Without a `guard`,
 *   `T` is an unchecked cast — prefer `unknown` or supply a guard for type
 *   safety.
 * @param raw   - Raw JSONL string (may include trailing newline or blank lines).
 * @param options - Optional guard and error callback (see {@link ParseJsonlOptions}).
 * @returns Array of parsed (and optionally type-narrowed) values.
 */
export function parseJsonlLines<T = unknown>(
  raw: string,
  options: ParseJsonlOptions<T> = {},
): T[] {
  const { guard, onParseError } = options;
  const out: T[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onParseError?.(trimmed);
      continue;
    }

    if (guard !== undefined) {
      if (!guard(parsed)) continue;
      out.push(parsed);
    } else {
      out.push(parsed as T);
    }
  }

  return out;
}
