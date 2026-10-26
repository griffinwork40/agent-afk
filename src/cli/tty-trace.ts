/**
 * TTY write recorder — asciinema v2 cast writer.
 *
 * When `AFK_TTY_TRACE` is set to a file path and `process.stdout` is a TTY,
 * this module tee-s every byte written to stdout and stderr into an asciinema
 * v2 cast file at that path. The file is written with a single sync fd so a
 * crash loses at most the current in-progress write, never the file itself.
 *
 * Invariant (no-crash guarantee): if opening or writing the cast file fails at
 * any point, the recorder disables itself with a one-time stderr warning and
 * never throws. The REPL is unaffected.
 *
 * Invariant (passthrough): the original write functions are called with their
 * original arguments — no batching, no delay, no mutation. Return values and
 * completion callbacks are forwarded unchanged.
 *
 * Invariant (multibyte safety): chunks may split a multibyte UTF-8 sequence
 * across write calls. We decode with a TextDecoder in `fatal:false` mode, which
 * replaces an incomplete trailing sequence with U+FFFD rather than throwing.
 * The cast records the decoded string, which is what the terminal renders.
 *
 * Invariant (testability): `installTtyTrace` accepts an optional `FsOps`
 * injection so unit tests can supply fake open/write/close without needing
 * to spy on ESM-locked `node:fs` named exports.
 *
 * @module cli/tty-trace
 */

import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { env } from '../config/env.js';
import { getTerminalHeight, getTerminalWidth } from './terminal-size.js';

// ── Injectable fs operations ─────────────────────────────────────────────────

/**
 * Subset of `node:fs` used by the recorder. Injected in tests; defaults to
 * the real `node:fs` functions in production.
 */
export interface FsOps {
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
}

// ── Types ────────────────────────────────────────────────────────────────────

type WriteFn = typeof process.stdout.write;

interface SavedWrites {
  stdoutWrite: WriteFn;
  stderrWrite: WriteFn;
}

// ── Module state (install/uninstall pair) ────────────────────────────────────

let _fd: number | null = null;
let _startMs: number = 0;
let _saved: SavedWrites | null = null;
let _disabled = false;
let _fs: FsOps = nodeFs;

// TextDecoder with fatal:false so incomplete multibyte sequences produce U+FFFD
// rather than throwing — safe for tee-d chunks that split a codepoint boundary.
let _decoder = new TextDecoder('utf-8', { fatal: false });

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Write one NDJSON line to the cast fd; disables on any error. */
function _writeLine(line: string): void {
  if (_fd === null || _disabled) return;
  try {
    _fs.writeSync(_fd, line + '\n');
  } catch {
    _disable('write error');
  }
}

/** Disable the recorder after a write error, emitting one stderr warning; the REPL keeps running. */
function _disable(reason: string): void {
  if (_disabled) return;
  _disabled = true;
  process.stderr.write(`[afk tty-trace] recorder disabled (${reason})\n`);
  if (_fd !== null) {
    try { _fs.closeSync(_fd); } catch { /* best-effort */ }
    _fd = null;
  }
}

/** Seconds since recording started, with millisecond precision. */
function _elapsed(): number {
  return (Date.now() - _startMs) / 1000;
}

/** Decode a Buffer or string chunk to a string for the cast event. */
function _decode(chunk: Uint8Array | string): string {
  if (typeof chunk === 'string') return chunk;
  return _decoder.decode(chunk, { stream: true });
}

/** Record an output event: `[t, "o", data]` */
function _recordOutput(chunk: Uint8Array | string): void {
  if (_fd === null || _disabled) return;
  const data = _decode(chunk);
  if (data.length === 0) return;
  _writeLine(JSON.stringify([_elapsed(), 'o', data]));
}

/** Record a resize event: `[t, "r", "COLSxROWS"]` */
function _recordResize(): void {
  if (_fd === null || _disabled) return;
  const cols = getTerminalWidth();
  const rows = getTerminalHeight();
  _writeLine(JSON.stringify([_elapsed(), 'r', `${cols}x${rows}`]));
}

/**
 * Build a wrapped write function that tee-s to the cast file then calls
 * the original. Preserves all overloads, return value, and callback semantics.
 */
function _wrapWrite(original: WriteFn): WriteFn {
  // Node's stream.write has three overloads; we accept any combo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function wrappedWrite(this: any, chunk: any, encodingOrCb?: any, cb?: any): boolean {
    _recordOutput(chunk as Uint8Array | string);
    // Forward to original preserving `this` (the stream itself).
    if (typeof encodingOrCb === 'function') {
      return original.call(this, chunk, encodingOrCb);
    }
    if (cb !== undefined) {
      return original.call(this, chunk, encodingOrCb, cb);
    }
    if (encodingOrCb !== undefined) {
      return original.call(this, chunk, encodingOrCb);
    }
    return original.call(this, chunk);
  } as WriteFn;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Install the TTY recorder. No-op when:
 *   - `AFK_TTY_TRACE` is unset
 *   - `process.stdout` is not a TTY
 *   - already installed
 *
 * Must be called before any REPL output so the header is the first line.
 *
 * @param fsOps - Optional fs operation overrides for testing. Defaults to
 *   the real `node:fs` functions. Pass a fake implementation in tests to
 *   avoid ESM-lock issues with `vi.spyOn`.
 */
export function installTtyTrace(fsOps?: FsOps): void {
  if (_saved !== null) return;                  // already installed
  const tracePath = env.AFK_TTY_TRACE;
  if (!tracePath) return;                       // opt-in only
  if (!process.stdout.isTTY) return;            // TTY guard — zero overhead otherwise

  // Use injected fs ops (tests) or the real node:fs (production).
  _fs = fsOps ?? nodeFs;

  // Expand leading ~/ using os.homedir() — immune to HOME injection via env vars.
  const home = homedir();
  const expandedPath = tracePath.startsWith('~/') ? home + tracePath.slice(1) : tracePath;

  // Open the file synchronously once. On error, warn once on stderr and leave
  // the recorder uninstalled (no wrappers); the REPL keeps running.
  try {
    _fd = _fs.openSync(expandedPath, 'w', 0o600);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[afk tty-trace] could not open ${expandedPath}: ${msg}\n`);
    return;
  }

  _startMs = Date.now();
  _disabled = false;

  // Write asciinema v2 header. env.TERM is registered in ENV_REGISTRY via
  // env.tty-trace.ts so this read goes through the typed env object.
  const cols = getTerminalWidth();
  const rows = getTerminalHeight();
  const header = {
    version: 2,
    width: cols,
    height: rows,
    timestamp: Math.floor(_startMs / 1000),
    env: { TERM: env.TERM ?? '' },
  };
  _writeLine(JSON.stringify(header));
  if (_disabled) return; // header write failed

  // Emit a one-time privacy notice so the operator knows the session is being recorded.
  process.stderr.write('[afk tty-trace] recording session to ' + expandedPath + ' — cast contains all terminal output; delete when done\n');

  // Save originals and install wrappers.
  _saved = {
    stdoutWrite: process.stdout.write.bind(process.stdout),
    stderrWrite: process.stderr.write.bind(process.stderr),
  };
  process.stdout.write = _wrapWrite(_saved.stdoutWrite);
  process.stderr.write = _wrapWrite(_saved.stderrWrite);

  // Record resize events. The listener is removed on uninstall.
  process.stdout.on('resize', _recordResize);
}

/**
 * Uninstall the TTY recorder and close the cast file.
 * Restores the original `process.stdout.write` and `process.stderr.write`.
 * Safe to call even if `installTtyTrace` was never called (no-op).
 */
export function uninstallTtyTrace(): void {
  if (_saved === null) return;

  process.stdout.write = _saved.stdoutWrite;
  process.stderr.write = _saved.stderrWrite;
  process.stdout.off('resize', _recordResize);
  _saved = null;

  if (_fd !== null) {
    try { _fs.closeSync(_fd); } catch { /* best-effort */ }
    _fd = null;
  }
  _disabled = false;
  _fs = nodeFs;
  _decoder = new TextDecoder('utf-8', { fatal: false });
}
