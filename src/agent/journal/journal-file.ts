/**
 * One journal file's writer: `sessions/<id>/journal.jsonl` for the top level
 * or `sessions/<id>/subagents/<subagentId>.jsonl` for a forked child. Built
 * by `createMessageJournal` (writer.ts), which owns the shared session state.
 *
 * Lifecycle:
 *   1. BUFFERING: the session id is unknown (or unsafe). Records are
 *      snapshotted as JSON strings (so later mutation of the caller's objects
 *      cannot change what lands) and kept in memory, bounded by
 *      {@link MAX_BUFFERED_RECORDS}; past the cap they are dropped with one
 *      warning. `length` tracks them, dropped ones included, so a
 *      `JournalSync` does not resync-loop against a full buffer.
 *   2. RESOLVED: the first time any method (or `length`) sees a safe id, the
 *      path is pinned, the on-disk fold length of an existing file becomes the
 *      base length, and the buffer drains through the write path.
 *   3. CLOSED: flushed; further writes are ignored.
 *
 * Invariant: every record (meta first, once per writer open, lazily before
 * the first record so an idle writer leaves no file) goes through one
 * {@link SerialQueue} task that writes its spilled blobs, THEN its line. If a
 * blob write fails the record is written unspilled instead (full content
 * inline beats a dangling ref).
 *
 * Invariant: the session id is pinned at first resolution. A later change of
 * `getSessionId()` does not move the journal; a new session builds a new one.
 *
 * @module agent/journal/journal-file
 */

import { randomUUID } from 'node:crypto';

import { getSessionJournalPath, getSubagentJournalPath, isSafeLedgerSessionId } from '../../paths.js';
import { JsonlFileAppender, SerialQueue, type OnceReporter } from './append-queue.js';
import type { BlobStore, PendingBlob } from './blobs.js';
import { foldLength, nextLength, readJournalFile } from './records.js';
import { spillMessage } from './spill.js';
import { JOURNAL_VERSION, type JournalRecordInput } from './types.js';

/** Buffered-record cap while the session id is unresolved. */
export const MAX_BUFFERED_RECORDS = 10_000;

/** State shared by a session's top-level journal and all of its subagent journals. */
export interface JournalSessionShared {
  getSessionId: () => string | undefined;
  meta: { provider?: string; model?: string; cwd?: string };
  blobs: BlobStore;
  report: OnceReporter;
}

interface Resolved {
  sessionId: string;
  appender: JsonlFileAppender;
  /** Prefix for the first line: repairs a torn (newline-less) tail. */
  lead: string;
}

export class JournalFileWriter {
  private readonly writerId = randomUUID();
  private readonly queue: SerialQueue;
  private resolved: Resolved | null = null;
  private failed = false;
  private closed = false;
  private metaWritten = false;
  private buffered: Array<{ ts: number; json: string }> = [];
  private bufferedDropped = false;
  private len = 0;

  constructor(
    private readonly shared: JournalSessionShared,
    readonly subagentId?: string,
  ) {
    this.queue = new SerialQueue((err) => shared.report('journal write failed', err));
  }

  get length(): number {
    this.tryResolve();
    return this.len;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Fire-and-forget; never throws (unserializable input is reported and dropped). */
  record(input: JournalRecordInput): void {
    try {
      this.recordUnsafe(input);
    } catch (err) {
      this.shared.report('journal record dropped', err);
    }
  }

  private recordUnsafe(input: JournalRecordInput): void {
    if (this.closed || this.failed) return;
    const ts = Date.now();
    this.tryResolve();
    if (this.resolved) {
      this.enqueue(this.resolved, input, ts);
      this.len = nextLength(this.len, input);
      return;
    }
    this.len = nextLength(this.len, input);
    if (this.buffered.length >= MAX_BUFFERED_RECORDS) {
      if (!this.bufferedDropped) {
        this.bufferedDropped = true;
        this.shared.report(`session id unresolved; dropping journal records past ${MAX_BUFFERED_RECORDS}`);
      }
      return;
    }
    this.buffered.push({ ts, json: JSON.stringify(input) });
  }

  async flush(): Promise<void> {
    this.tryResolve();
    await this.queue.idle();
  }

  async close(): Promise<void> {
    if (this.closed) return this.queue.idle();
    this.tryResolve();
    this.closed = true;
    this.buffered = [];
    await this.queue.idle();
  }

  /** Resolve the session id if it is now known; drain the buffer on first success. */
  private tryResolve(): void {
    if (this.resolved || this.failed) return;
    let id: string | undefined;
    try {
      id = this.shared.getSessionId();
    } catch {
      return;
    }
    if (typeof id !== 'string' || !isSafeLedgerSessionId(id)) return;
    let path: string;
    try {
      path = this.subagentId === undefined ? getSessionJournalPath(id) : getSubagentJournalPath(id, this.subagentId);
    } catch (err) {
      this.failed = true;
      this.buffered = [];
      this.shared.report('invalid journal path', err);
      return;
    }
    const existing = readJournalFile(path);
    const resolved: Resolved = {
      sessionId: id,
      appender: new JsonlFileAppender(path),
      lead: existing.endsWithNewline ? '' : '\n',
    };
    this.resolved = resolved;
    const pending = this.buffered;
    this.buffered = [];
    // Base length = the on-disk fold; buffered records then apply on top.
    this.len = foldLength(existing.records);
    for (const b of pending) {
      const input = JSON.parse(b.json) as JournalRecordInput;
      this.len = nextLength(this.len, input);
      this.enqueue(resolved, input, b.ts);
    }
  }

  private enqueue(r: Resolved, input: JournalRecordInput, ts: number): void {
    let lines = '';
    if (!this.metaWritten) {
      this.metaWritten = true;
      lines += this.metaLine(r.sessionId, ts);
    }
    let blobs: PendingBlob[] = [];
    let line: string;
    let fallback: string | null = null;
    if (input.kind === 'append') {
      const spilled = spillMessage(r.sessionId, input.message);
      blobs = spilled.blobs;
      line = serialize({ ...input, message: spilled.message }, ts);
      if (blobs.length > 0) fallback = serialize(input, ts);
    } else {
      line = serialize(input, ts);
    }
    const head = lines;
    this.queue.push(async () => {
      let out = line;
      try {
        for (const b of blobs) await this.shared.blobs.write(b);
      } catch (err) {
        this.shared.report('journal blob write failed; recording inline', err);
        out = fallback ?? line;
      }
      await r.appender.write(r.lead + head + out);
      r.lead = '';
    });
  }

  private metaLine(sessionId: string, ts: number): string {
    const m = this.shared.meta;
    return (
      JSON.stringify({
        v: JOURNAL_VERSION,
        ts,
        kind: 'meta',
        sessionId,
        ...(this.subagentId !== undefined ? { subagentId: this.subagentId } : {}),
        writerId: this.writerId,
        ...(m.provider !== undefined ? { provider: m.provider } : {}),
        ...(m.model !== undefined ? { model: m.model } : {}),
        ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
      }) + '\n'
    );
  }
}

function serialize(input: JournalRecordInput, ts: number): string {
  return JSON.stringify({ v: JOURNAL_VERSION, ts, ...input }) + '\n';
}
