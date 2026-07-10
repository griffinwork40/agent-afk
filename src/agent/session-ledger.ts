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
 *   - The ledger is a PROJECTION, not a transcript: per-token text/thinking
 *     deltas, progress events, suggestions, and panel payloads are skipped.
 *     What lands: user turns, full assistant messages, tool starts, failed
 *     tool results, turn completions, errors, pause/resume, and a terminal
 *     `closed` record. This keeps files compact and phone-renderable.
 *   - `tailLedger` polls (250ms) with `fs.watch` as wakeup, yielding records
 *     until the consumer aborts or a `closed` record is read.
 *
 * @module agent/session-ledger
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { getSessionLedgerDir, getSessionLedgerPath, isSafeLedgerSessionId } from '../paths.js';
import type { OutputEvent } from './types/session-types.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

/** One JSONL line in a session ledger. `v` is the schema version. */
export type LedgerRecord = { v: 1; ts: number } & LedgerPayload;

export type LedgerPayload =
  /** Session-level metadata, written once when the ledger opens.
   *  `traceLabel` is the witness-trace directory name (`state/witness/<label>/`)
   *  for this session, letting a reader correlate the id-keyed ledger to the
   *  trace — whose label is a random UUID for fresh sessions, decoupled from
   *  the session id. `null` means no trace was wired (tracing disabled/failed),
   *  making that state explicit rather than a silently-absent directory.
   *  Optional for back-compat with ledgers written before this field existed. */
  | {
      kind: 'meta';
      sessionId: string;
      model: string;
      cwd?: string;
      surface?: string;
      traceLabel?: string | null;
    }
  /** A user turn entering the session (summary text, never raw blocks). */
  | { kind: 'user'; text: string }
  /** A complete assistant message. */
  | { kind: 'assistant'; text: string }
  /** A tool invocation starting. `input` is a preview, capped at source. */
  | { kind: 'tool'; toolName: string; input: string }
  /** A failed tool result (successful results are skipped — too chatty). */
  | { kind: 'tool_error'; toolName?: string; content: string }
  /** Turn completed. Cost/duration when the provider reported them. */
  | { kind: 'done'; costUsd?: number; durationMs?: number }
  /** Stream-level error. Message only — Error objects don't survive JSON. */
  | { kind: 'error'; message: string }
  /** Provider paused on a usage limit. */
  | { kind: 'paused'; resetsAt?: string }
  /** Provider resumed after a usage-limit pause. */
  | { kind: 'resumed' }
  // Invariant: the three AFK remote-control records below carry the
  // cross-process elicitation/abort protocol (REPL session <-> Telegram daemon)
  // over the same ledger file. `elicitation` is written by the REPL when the
  // agent asks a question while AFK; `elicitation_response` and `abort_request`
  // are written BACK by the daemon and MUST carry a per-session HMAC (see
  // afk-channel.ts) — the REPL refuses any whose signature does not verify, so a
  // stray or cross-session write can never resolve a question or abort a turn.
  /** AFK: the agent asked a question; `reqId` correlates the response. */
  | { kind: 'elicitation'; reqId: string; request: ElicitationRequest }
  /** AFK: an answer to a prior `elicitation`, signed by the daemon. */
  | { kind: 'elicitation_response'; reqId: string; result: ElicitationResult; hmac: string }
  /** AFK: a signed request to abort the running turn. */
  | { kind: 'abort_request'; nonce: string; hmac: string }
  /** Terminal record: the hosting process closed the session. */
  | { kind: 'closed'; reason?: string };

/** Cap stored user/assistant text so a pasted file can't bloat the ledger. */
const MAX_TEXT_LEN = 8_000;
/** Cap stored tool-input previews. */
const MAX_TOOL_INPUT_LEN = 400;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/**
 * Project an `OutputEvent` onto a ledger payload, or `null` for events the
 * ledger intentionally skips (deltas, progress, suggestions, panels,
 * stream-retry markers).
 */
export function projectOutputEvent(event: OutputEvent): LedgerPayload | null {
  switch (event.type) {
    case 'message':
      if (event.message.role !== 'assistant' || !event.message.content) return null;
      return { kind: 'assistant', text: clip(event.message.content, MAX_TEXT_LEN) };
    case 'chunk': {
      const chunk = event.chunk;
      if (chunk.type === 'tool_use_detail') {
        return {
          kind: 'tool',
          toolName: chunk.toolName,
          input: clip(chunk.toolInput, MAX_TOOL_INPUT_LEN),
        };
      }
      if (chunk.type === 'tool_result' && chunk.isError === true) {
        return { kind: 'tool_error', content: clip(chunk.content, MAX_TOOL_INPUT_LEN) };
      }
      return null;
    }
    case 'done': {
      const cost = event.metadata?.totalCostUsd;
      const duration = event.metadata?.durationMs;
      return {
        kind: 'done',
        ...(typeof cost === 'number' ? { costUsd: cost } : {}),
        ...(typeof duration === 'number' ? { durationMs: duration } : {}),
      };
    }
    case 'error':
      return { kind: 'error', message: event.error.message };
    case 'paused':
      return {
        kind: 'paused',
        ...(event.resetsAt ? { resetsAt: event.resetsAt.toISOString() } : {}),
      };
    case 'resumed':
      return { kind: 'resumed' };
    default:
      // progress | suggestion | stream_retry | panel — intentionally skipped.
      return null;
  }
}

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
  record(payload: LedgerPayload): void {
    if (this.errored || this.closed) return;
    const rec: LedgerRecord = { v: 1, ts: Date.now(), ...payload };
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

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Parse one ledger line; returns null for blank/malformed lines. */
function parseRecord(line: string): LedgerRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as LedgerRecord;
    if (parsed.v !== 1 || typeof parsed.ts !== 'number' || typeof parsed.kind !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Whether a ledger file exists for the given session id. */
export async function ledgerExists(sessionId: string): Promise<boolean> {
  if (!isSafeLedgerSessionId(sessionId)) return false;
  try {
    await fsp.access(getSessionLedgerPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Read all records from a session ledger (ENOENT → zero records). */
export async function* readLedger(sessionId: string): AsyncGenerator<LedgerRecord> {
  if (!isSafeLedgerSessionId(sessionId)) return;
  let fd: fsp.FileHandle;
  try {
    fd = await fsp.open(getSessionLedgerPath(sessionId), 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  try {
    const rl = readline.createInterface({
      input: fd.createReadStream({ encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const rec = parseRecord(line);
      if (rec) yield rec;
    }
  } finally {
    await fd.close();
  }
}

const POLL_INTERVAL_MS = 250;

/**
 * Tail a session ledger — for live following from another process.
 *
 * - `fromStart: true` replays existing records first; otherwise starts at
 *   the current end of file (or 0 if the file doesn't exist yet).
 * - Yields until a `closed` record is read or `signal` aborts.
 * - `fs.watch` on the ledger directory is the wakeup; a 250ms poll is the
 *   fallback — on macOS watch events are coalesced/dropped under load, so
 *   the poll floor is load-bearing, not belt-and-braces.
 */
export async function* tailLedger(
  sessionId: string,
  opts?: { fromStart?: boolean; signal?: AbortSignal },
): AsyncGenerator<LedgerRecord> {
  if (!isSafeLedgerSessionId(sessionId)) return;
  const ledgerPath = getSessionLedgerPath(sessionId);
  const ledgerDir = getSessionLedgerDir(sessionId);
  const { fromStart = false, signal } = opts ?? {};

  let fileOffset = 0;
  let buffer = '';
  let sawClosed = false;

  async function* readNewRecords(): AsyncGenerator<LedgerRecord> {
    let fd: fsp.FileHandle | null = null;
    try {
      fd = await fsp.open(ledgerPath, 'r');
      const stat = await fd.stat();
      if (stat.size <= fileOffset) return;
      const toRead = stat.size - fileOffset;
      const readBuf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fd.read(readBuf, 0, toRead, fileOffset);
      if (bytesRead === 0) return;
      fileOffset += bytesRead;
      buffer += readBuf.toString('utf8', 0, bytesRead);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const rec = parseRecord(line);
        if (!rec) continue;
        if (rec.kind === 'closed') sawClosed = true;
        yield rec;
        if (sawClosed) return;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[afk] session-ledger: tail read error for ${sessionId}: ${String(e)}\n`);
      }
    } finally {
      if (fd) await fd.close().catch(() => { /* ignore */ });
    }
  }

  if (!fromStart) {
    try {
      const stat = await fsp.stat(ledgerPath);
      fileOffset = stat.size;
    } catch {
      // File doesn't exist yet — start from 0 and wait for it to appear.
    }
  } else {
    yield* readNewRecords();
    if (sawClosed) return;
  }

  let watcher: fs.FSWatcher | null = null;
  let watcherChange: (() => void) | null = null;

  const waitForChange = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const pollTimer = setTimeout(() => {
        watcherChange = null;
        resolve();
      }, POLL_INTERVAL_MS);
      watcherChange = () => {
        clearTimeout(pollTimer);
        watcherChange = null;
        resolve();
      };
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(pollTimer);
          watcherChange = null;
          resolve();
        },
        { once: true },
      );
    });

  try {
    // Watch the parent dir, not the file — the file may not exist yet.
    watcher = fs.watch(ledgerDir, { persistent: false }, () => {
      watcherChange?.();
    });
  } catch {
    // Pure polling fallback.
  }

  try {
    while (!signal?.aborted && !sawClosed) {
      await waitForChange();
      if (signal?.aborted) break;
      yield* readNewRecords();
    }
  } finally {
    watcher?.close();
  }
}
