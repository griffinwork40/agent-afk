/**
 * Per-session durable event ledger.
 *
 * Every top-level `AgentSession` appends a filtered projection of its
 * `OutputEvent` stream to `~/.afk/state/sessions/<sessionId>/events.jsonl`.
 * Any other process (the Telegram bot's `/watch`, a future `afk attach`)
 * can tail that file to observe the session live — cross-surface visibility
 * without a shared process, HTTP server, or new daemon dependency.
 *
 * Design (mirrors `bg-job-log.ts`, the proven JSONL writer/tailer pattern):
 *   - Writer uses a lazy append stream — sessions that never produce a
 *     ledger-worthy event leave no file.
 *   - Disk errors are caught and suppressed on the write path: a session
 *     must never fail because the ledger directory is unwritable.
 *   - The ledger is a PROJECTION, not a transcript: per-token text deltas,
 *     suggestions, stream-retry markers, and panel payloads are skipped.
 *     What lands: user turns, full assistant messages, thinking blocks,
 *     tool starts, successful + failed tool results, turn completions with
 *     token breakdown, errors, pause/resume, tool activity, rate-limit,
 *     progress, subagent lifecycle, background-job, and plan-mode events.
 *   - `tailLedger` polls (250ms) with `fs.watch` as wakeup, yielding records
 *     until the consumer aborts or a `closed` record is read.
 *
 * Concerns extracted to sibling modules to stay within the 350-LOC ceiling:
 *   - Types + `projectOutputEvent`: `session-ledger-project.ts`
 *   - Read-side utilities: `session-ledger-reader.ts`
 *
 * @module agent/session-ledger
 */

import * as fs from 'node:fs';
import { getSessionLedgerDir, getSessionLedgerPath, isSafeLedgerSessionId } from '../paths.js';
import type { OutputEvent } from './types/session-types.js';
import { clip, MAX_TEXT_LEN, projectOutputEvent } from './session-ledger-project.js';

// Re-export public API from the extracted modules so existing import paths work.
export type { LedgerRecord, LedgerPayload } from './session-ledger-project.js';
export { projectOutputEvent } from './session-ledger-project.js';
export { ledgerExists, readLedger, tailLedger } from './session-ledger-reader.js';

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Append-only ledger writer for one session. Same error posture as
 * `BgJobLogWriter`: all I/O failures are logged to stderr and swallowed.
 */
export class SessionLedgerWriter {
  private readonly sessionId: string;
  private readonly ledgerPath: string;
  private stream: fs.WriteStream | null = null;
  private errored = false;
  private closed = false;
  private streamReady = false;
  private pendingLines: string[] = [];
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    if (!isSafeLedgerSessionId(sessionId)) {
      // Never throw from the session hot path — an exotic provider-issued id
      // just disables the ledger for this session.
      this.errored = true;
      this.ledgerPath = '';
      return;
    }
    this.ledgerPath = getSessionLedgerPath(sessionId);
    try {
      fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });
    } catch (e) {
      process.stderr.write(`[afk] session-ledger: mkdir failed for ${sessionId}: ${String(e)}\n`);
      this.errored = true;
    }
  }

  /** Whether this writer can accept records. */
  get active(): boolean {
    return !this.errored && !this.closed;
  }

  /** Append a payload as a timestamped JSONL record. Fire-and-forget. */
  record(payload: import('./session-ledger-project.js').LedgerPayload): void {
    if (this.errored || this.closed) return;
    const rec = { v: 1 as const, ts: Date.now(), ...payload };
    const line = JSON.stringify(rec) + '\n';
    if (!this.stream) {
      this.pendingLines.push(line);
      this._openStream();
      return;
    }
    if (!this.streamReady) {
      this.pendingLines.push(line);
      return;
    }
    this._writeLine(line);
  }

  /** Project and append an OutputEvent. No-ops for skipped event types. */
  recordEvent(event: OutputEvent): void {
    const payload = projectOutputEvent(event);
    if (payload) this.record(payload);
  }

  /** Record a user turn entering the session. */
  recordUser(text: string): void {
    this.record({ kind: 'user', text: clip(text, MAX_TEXT_LEN) });
  }

  private _openStream(): void {
    if (this.stream) return;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    try {
      const s = fs.createWriteStream(this.ledgerPath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
      this.stream = s;
      s.once('open', () => {
        this.streamReady = true;
        for (const line of this.pendingLines) this._writeLine(line);
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
      s.once('error', (err) => {
        process.stderr.write(`[afk] session-ledger: stream error for ${this.sessionId}: ${String(err)}\n`);
        this.errored = true;
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
    } catch (e) {
      process.stderr.write(`[afk] session-ledger: createWriteStream failed for ${this.sessionId}: ${String(e)}\n`);
      this.errored = true;
      this.pendingLines = [];
      this.readyResolve?.();
      this.readyResolve = null;
    }
  }

  private _writeLine(line: string): void {
    if (!this.stream || this.errored) return;
    try {
      this.stream.write(line, (err) => {
        if (err) {
          process.stderr.write(`[afk] session-ledger: write error for ${this.sessionId}: ${String(err)}\n`);
          this.errored = true;
        }
      });
    } catch (e) {
      process.stderr.write(`[afk] session-ledger: write threw for ${this.sessionId}: ${String(e)}\n`);
      this.errored = true;
    }
  }

  /**
   * Write the terminal `closed` record, flush, and close the stream.
   * Idempotent — safe to call from both `close()` and `reset()` paths.
   */
  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.record({ kind: 'closed', ...(reason !== undefined ? { reason } : {}) });
    this.closed = true;
    if (this.readyPromise) await this.readyPromise;
    return new Promise<void>((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
    });
  }
}
