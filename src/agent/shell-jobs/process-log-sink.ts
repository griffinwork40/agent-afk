/**
 * Capped, rotating log-file sink for model-started background processes.
 *
 * A background process may run for hours and print without bound (a model
 * server logging every request, a dev server rebuilding). Unlike the
 * foreground bash tool and the user `!&` streamer, which KILL the process when
 * their in-memory buffer fills, this sink never stops the process: it writes
 * raw bytes to `<logPath>` and, when that file reaches `capBytes`, renames it
 * to `<logPath>.1` (replacing any previous rotation) and starts a fresh file.
 * Disk use per job is therefore bounded at roughly `2 * capBytes`.
 *
 * It also keeps a small ANSI-stripped in-memory tail so the health tool can
 * return recent output without reading the file.
 *
 * Invariant: every method swallows filesystem errors after the first one is
 * recorded in `lastError`. A full disk or a deleted log directory must never
 * crash the afk process or the supervised job; the job keeps running and the
 * health tool reports the write error.
 *
 * @module agent/shell-jobs/process-log-sink
 */

import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { makeAnsiStripper, type AnsiStripper } from './streamer.js';
import { errorMessage } from '../../utils/errors.js';

/** Default per-file cap. Two files (current + one rotation) bound disk use. */
export const DEFAULT_LOG_CAP_BYTES = 32 * 1024 * 1024;
/** Characters of ANSI-stripped output retained in memory. */
export const DEFAULT_TAIL_CHARS = 8 * 1024;

export interface ProcessLogSinkOptions {
  logPath: string;
  capBytes?: number;
  tailChars?: number;
}

export class ProcessLogSink {
  readonly logPath: string;
  private readonly capBytes: number;
  private readonly tailChars: number;
  // Per-stream decoding state: a UTF-8 sequence or an ANSI escape split across
  // two chunks of ONE stream must not be corrupted by the other stream's data.
  private readonly streams = {
    stdout: { decoder: new StringDecoder('utf8'), stripper: makeAnsiStripper() as AnsiStripper },
    stderr: { decoder: new StringDecoder('utf8'), stripper: makeAnsiStripper() as AnsiStripper },
  };
  private fd: number | undefined;
  private fileBytes = 0;
  private _totalBytes = 0;
  private _rotations = 0;
  private _tail = '';
  private _lastError: string | undefined;

  constructor(opts: ProcessLogSinkOptions) {
    this.logPath = opts.logPath;
    this.capBytes = Math.max(1024, opts.capBytes ?? DEFAULT_LOG_CAP_BYTES);
    this.tailChars = Math.max(256, opts.tailChars ?? DEFAULT_TAIL_CHARS);
    this.openFresh();
  }

  /** Total bytes the process has written (including rotated-away bytes). */
  get totalBytes(): number { return this._totalBytes; }
  /** Number of rotations performed. */
  get rotations(): number { return this._rotations; }
  /** First filesystem error seen, if any. */
  get lastError(): string | undefined { return this._lastError; }

  /** Recent ANSI-stripped output, at most `maxChars` characters. */
  tail(maxChars = this.tailChars): string {
    return this._tail.length <= maxChars ? this._tail : this._tail.slice(-maxChars);
  }

  /** Append one chunk from stdout or stderr. */
  write(chunk: Buffer, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this._totalBytes += chunk.length;
    this.appendTail(chunk, stream);
    if (this.fd === undefined) return;
    try {
      if (this.fileBytes > 0 && this.fileBytes + chunk.length > this.capBytes) this.rotate();
      if (this.fd === undefined) return;
      // writeSync may write fewer bytes than asked; loop until done.
      let off = 0;
      while (off < chunk.length) off += fs.writeSync(this.fd, chunk, off, chunk.length - off);
      this.fileBytes += chunk.length;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Close the file descriptor. Idempotent. */
  close(): void {
    // Discarded residue is an incomplete escape sequence, never printable text.
    this.streams.stdout.stripper.flush();
    this.streams.stderr.stripper.flush();
    if (this.fd === undefined) return;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.fd = undefined;
  }

  private appendTail(chunk: Buffer, stream: 'stdout' | 'stderr'): void {
    const s = this.streams[stream];
    this._tail += s.stripper.strip(s.decoder.write(chunk));
    if (this._tail.length > this.tailChars * 2) this._tail = this._tail.slice(-this.tailChars);
  }

  private openFresh(): void {
    try {
      this.fd = fs.openSync(this.logPath, 'w', 0o600);
      this.fileBytes = 0;
    } catch (err) {
      this.fd = undefined;
      this.fail(err);
    }
  }

  private rotate(): void {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* best effort */ }
      this.fd = undefined;
    }
    // If the rename fails (e.g. the rotation target is unwritable), openFresh
    // truncates the current file instead: logging continues, history is lost.
    try { fs.renameSync(this.logPath, `${this.logPath}.1`); } catch { /* truncate instead */ }
    this._rotations++;
    this.openFresh();
  }

  private fail(err: unknown): void {
    if (this._lastError === undefined) this._lastError = errorMessage(err);
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* best effort */ }
    }
    this.fd = undefined;
  }
}
