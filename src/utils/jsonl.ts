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

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { isEnoent } from './errors.js';

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

// ---------------------------------------------------------------------------
// readJsonlFile — streaming, fd-safe, ENOENT-aware async generator
// ---------------------------------------------------------------------------

/**
 * Streaming JSONL reader — opens the file once with a readline interface and
 * yields each successfully-parsed value. Handles ENOENT gracefully (zero
 * values). Malformed lines are skipped (tolerant contract identical to
 * `parseJsonlLines`).
 *
 * The file descriptor is always closed, even on early generator return.
 *
 * @typeParam T - Element type. Without a `guard`, every parsed value is
 *   yielded as `unknown`.
 * @param filePath - Absolute path to the `.jsonl` file.
 * @param options  - Optional type guard and parse-error callback.
 */
export async function* readJsonlFile<T = unknown>(
  filePath: string,
  options: ParseJsonlOptions<T> = {},
): AsyncGenerator<T> {
  const { guard, onParseError } = options;

  let fd: fsp.FileHandle;
  try {
    fd = await fsp.open(filePath, 'r');
  } catch (e) {
    if (isEnoent(e)) return;
    throw e;
  }

  try {
    const rl = readline.createInterface({
      input: fd.createReadStream({ encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
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
        yield parsed;
      } else {
        yield parsed as T;
      }
    }
  } finally {
    await fd.close();
  }
}

// ---------------------------------------------------------------------------
// IncrementalLineReader — byte/framing state for incremental reads
// ---------------------------------------------------------------------------

/**
 * Stateful reader that handles incremental byte reads from a growing JSONL
 * file. Callers feed raw UTF-8 chunks; `IncrementalLineReader` buffers
 * incomplete lines across reads and emits complete lines on each call.
 *
 * Design notes:
 *   - `buffer` holds bytes that have not yet been terminated by `\n`.
 *   - `lines()` returns only complete (newline-terminated) lines.
 *   - `flush()` drains any remaining buffered content as a final line (use
 *     at EOF if the file lacks a trailing newline).
 *   - The caller tracks `fileOffset` and is responsible for advancing it —
 *     this class owns only the framing state, not the I/O.
 *
 * Typical usage:
 * ```ts
 * const reader = new IncrementalLineReader();
 * // … read new bytes into `chunk` …
 * for (const line of reader.feed(chunk)) {
 *   // process complete line
 * }
 * // at EOF:
 * for (const line of reader.flush()) { … }
 * ```
 */
export class IncrementalLineReader {
  private buffer: string = '';

  /**
   * Feed a new UTF-8 chunk. Returns an iterable of complete lines (without
   * the trailing `\n`). Incomplete lines are buffered for the next call.
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // The last element is either empty (trailing \n) or an incomplete line.
    this.buffer = parts.pop() ?? '';
    return parts;
  }

  /**
   * Drain any remaining buffered content as a final line. Call once at EOF
   * (when the file has no trailing newline). Safe to call even when the
   * buffer is empty — returns an empty array in that case.
   */
  flush(): string[] {
    if (this.buffer === '') return [];
    const remaining = this.buffer;
    this.buffer = '';
    return [remaining];
  }

  /**
   * Current length of the internal buffer in UTF-16 code units (i.e.
   * `String.prototype.length` units), not bytes. For ASCII-only content the
   * two are equivalent. If you need the byte count for a multi-byte payload,
   * use `Buffer.byteLength(reader.bufferedLength.toString())` instead —
   * though in practice this property is only used for diagnostic purposes
   * where code-unit precision is sufficient.
   */
  get bufferedLength(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// appendJsonl — explicit mode/error policy
// ---------------------------------------------------------------------------

/** Policy for how `appendJsonl` handles errors during the write. */
export type AppendJsonlErrorPolicy =
  /** Silently ignore write errors (fire-and-forget). Default. */
  | 'ignore'
  /** Re-throw the original error to the caller. */
  | 'throw';

/** Options for {@link appendJsonl}. */
export interface AppendJsonlOptions {
  /**
   * Error policy on `appendFile` failure.
   * - `'ignore'` (default): swallow the error silently.
   * - `'throw'`:  re-throw to the caller.
   */
  errorPolicy?: AppendJsonlErrorPolicy;
}

/**
 * Serialize `value` to JSON and append it as a single JSONL line (with a
 * trailing newline) to `filePath`. The parent directory must already exist;
 * this function does not call `mkdirSync` / `mkdirp`.
 *
 * Uses `fs.appendFileSync` — synchronous, atomic per-write on Linux/macOS
 * for writes under 4 KB. For larger payloads or write-heavy paths, callers
 * that already own an open write stream should continue using that stream
 * directly.
 *
 * The `errorPolicy` option controls what happens when the underlying
 * `appendFileSync` fails:
 *   - `'ignore'` (default): the error is swallowed, matching the pre-existing
 *     behavior of most call-sites that wrapped `appendFileSync` in a try/catch
 *     with an empty catch block.
 *   - `'throw'`: the error is re-thrown so the caller can log or propagate it.
 *
 * @param filePath    - Absolute path to the `.jsonl` file.
 * @param value       - Any JSON-serializable value.
 * @param options     - Optional error policy.
 */
export function appendJsonl(
  filePath: string,
  value: unknown,
  options: AppendJsonlOptions = {},
): void {
  const { errorPolicy = 'ignore' } = options;
  const line = `${JSON.stringify(value)}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch (err) {
    if (errorPolicy === 'throw') throw err;
    // 'ignore': swallow silently
  }
}
