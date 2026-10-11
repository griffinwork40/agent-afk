/**
 * JSON-file persistence helpers built on top of atomic-write.
 *
 * # Why this module exists
 *
 * JSON files are written throughout agent-afk with inconsistent durability and
 * error contracts:
 *   - Some callers use a hand-rolled tmp+rename block (duplicating the logic in
 *     `atomic-write.ts` with varying temp-name schemes and cleanup discipline).
 *   - Some callers use bare `writeFile` / `writeFileSync`, exposing torn writes
 *     on crash or SIGKILL.
 *   - Read-or-default blocks silently catch ALL errors instead of only ENOENT.
 *
 * This module standardises three primitives:
 *
 *   writeJsonFile(path, value, opts?)   — atomic JSON write via tmp+rename.
 *   readJsonFile(path, opts?)           — read JSON; throws on parse error;
 *                                         returns `onMissing` for ENOENT only.
 *   readJsonFileLoose(path, opts?)      — tolerant read; returns `onMissing`
 *                                         for ENOENT and parse errors; re-throws
 *                                         unexpected I/O errors (EACCES, EISDIR).
 *
 * Rule: **never convert a strict reader into catch-all**. Use `readJsonFile`
 * when a corrupt file should surface as an error; use `readJsonFileLoose`
 * only when empty/missing and corrupt/invalid should all return the default.
 *
 * # File modes
 *
 * `writeJsonFile` defaults to `0o600` (owner read/write) via the underlying
 * `atomicWriteFileAsync` / `atomicWriteFile` — secret-bearing files stay
 * protected through the temp-file window. Pass `{ mode: 0o644 }` for
 * world-readable config files.
 *
 * # JSON formatting
 *
 * The default indent is `2` (two spaces), matching the existing convention
 * across the codebase. Pass `{ indent: 0 }` for compact single-line output.
 *
 * @module utils/json-file
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWriteFile, atomicWriteFileAsync } from './atomic-write.js';
import { isEnoent, isErrnoCode } from './errors.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WriteJsonOptions {
  /**
   * JSON.stringify indent depth. Defaults to `2`.
   */
  indent?: number;
  /**
   * POSIX file-creation mode bits applied to the temp file before rename.
   * Defaults to `0o600` (owner read/write) via atomic-write.
   */
  mode?: number;
}

export interface ReadJsonOptions<T> {
  /**
   * Value returned when the file does not exist (ENOENT).
   * When `undefined` (the default) an ENOENT error is re-thrown just like
   * any other I/O error — callers that want a missing-file default must
   * supply this explicitly.
   */
  onMissing?: T;
}

// ---------------------------------------------------------------------------
// Sync write
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to JSON and write it to `path` atomically (tmp+rename).
 *
 * Synchronous — suitable for callers that already use synchronous I/O (e.g.
 * schedule-store, plugin index-store, memory-store HOT.md write path).
 * Prefer the async overload `writeJsonFileAsync` in async contexts.
 *
 * @param path  - Absolute destination path.
 * @param value - JSON-serializable value to write.
 * @param opts  - Optional indent, mode.
 */
export function writeJsonFile(path: string, value: unknown, opts: WriteJsonOptions = {}): void {
  const indent = opts.indent ?? 2;
  const mode = opts.mode;
  const payload = `${JSON.stringify(value, null, indent)}\n`;
  atomicWriteFile(path, payload, ...(mode !== undefined ? [{ mode }] : [{}]));
}

// ---------------------------------------------------------------------------
// Async write
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to JSON and write it to `path` atomically (tmp+rename).
 *
 * Asynchronous — prefer this in async contexts.
 *
 * @param path  - Absolute destination path.
 * @param value - JSON-serializable value to write.
 * @param opts  - Optional indent, mode.
 */
export async function writeJsonFileAsync(
  path: string,
  value: unknown,
  opts: WriteJsonOptions = {},
): Promise<void> {
  const indent = opts.indent ?? 2;
  const mode = opts.mode;
  const payload = `${JSON.stringify(value, null, indent)}\n`;
  await atomicWriteFileAsync(path, payload, ...(mode !== undefined ? [{ mode }] : [{}]));
}

// ---------------------------------------------------------------------------
// Sync read — strict ENOENT only
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file synchronously.
 *
 * - ENOENT: returns `opts.onMissing` when provided; re-throws when absent.
 * - Parse error: always re-thrown (never silently swallowed).
 * - Other I/O errors: always re-thrown.
 *
 * Use this when a corrupt or missing file indicates a real problem that
 * should surface to the caller.
 *
 * @param path  - Absolute file path to read.
 * @param opts  - Optional `onMissing` default.
 */
export function readJsonFile<T>(path: string, opts?: ReadJsonOptions<T>): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err) && opts !== undefined && 'onMissing' in opts) {
      return opts.onMissing as T;
    }
    throw err;
  }
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Async read — strict ENOENT only
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file asynchronously.
 *
 * Identical semantics to `readJsonFile` but async.
 */
export async function readJsonFileAsync<T>(path: string, opts?: ReadJsonOptions<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err) && opts !== undefined && 'onMissing' in opts) {
      return opts.onMissing as T;
    }
    throw err;
  }
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Sync read — tolerant (ENOENT + parse errors)
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file synchronously, tolerating missing files AND parse
 * errors.
 *
 * Returns `opts.onMissing` (or `undefined`) for:
 *   - ENOENT (file not found — expected missing-state)
 *   - SyntaxError / JSON parse failures (corrupt state treated as empty)
 *
 * **Re-throws** unexpected I/O errors (e.g. EACCES, EISDIR) so permission
 * problems and path-type mismatches are not silently swallowed.
 *
 * Use this **only** when corrupt and missing files should both degrade silently
 * to a default (e.g. bootstrap paths where a missing or corrupt state file is
 * indistinguishable from an empty state). For all other callers prefer
 * `readJsonFile` so corruption surfaces as an error.
 *
 * @param path  - Absolute file path to read.
 * @param opts  - Optional `onMissing` default (defaults to `undefined`).
 */
export function readJsonFileLoose<T>(path: string, opts?: ReadJsonOptions<T>): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return opts !== undefined && 'onMissing' in opts ? opts.onMissing : undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // JSON.parse only throws SyntaxError for string input — rethrow anything
    // else so non-parse errors (e.g. unexpected engine bugs) are not silently
    // swallowed.
    if (!(err instanceof SyntaxError)) throw err;
    return opts !== undefined && 'onMissing' in opts ? opts.onMissing : undefined;
  }
}

// ---------------------------------------------------------------------------
// Async read — tolerant (ENOENT + parse errors)
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file asynchronously, tolerating missing files AND parse
 * errors.
 *
 * Identical semantics to `readJsonFileLoose` but async — ENOENT and parse
 * errors return `onMissing`; all other I/O errors (EACCES, EISDIR, …) are
 * re-thrown.
 */
export async function readJsonFileLooseAsync<T>(
  path: string,
  opts?: ReadJsonOptions<T>,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return opts !== undefined && 'onMissing' in opts ? opts.onMissing : undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // JSON.parse only throws SyntaxError for string input — rethrow anything
    // else so non-parse errors (e.g. unexpected engine bugs) are not silently
    // swallowed.
    if (!(err instanceof SyntaxError)) throw err;
    return opts !== undefined && 'onMissing' in opts ? opts.onMissing : undefined;
  }
}
