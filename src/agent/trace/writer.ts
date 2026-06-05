/**
 * Witness-layer trace writers.
 *
 * Two implementations:
 *
 *   - {@link NdjsonTraceWriter} — appends to `<traceDir>/trace.jsonl` and
 *     writes compaction sidecars to `<traceDir>/<seq>-<ts>-pre-compaction.json`.
 *     Production sink.
 *
 *   - {@link InMemoryTraceWriter} — accumulates events in an array.
 *     Test sink.
 *
 * Invariants enforced here:
 *
 *   - **Append-only.** Once `write()` returns, the event is on disk in
 *     order. The writer serializes calls through an internal promise
 *     queue so concurrent emitters never interleave.
 *
 *   - **Monotonic `seq`.** The first event is `seq: 0`; each subsequent
 *     event increments. The counter is owned by the writer, never the
 *     caller.
 *
 *   - **Witness memory must not compress.** Compaction events carry the
 *     full pre-compaction message slice in their input form. The writer
 *     persists that slice to a sidecar file (full fidelity, SHA-256
 *     hashed) and writes a reference in the JSONL line. The original
 *     slice is never summarized or truncated by the writer.
 *
 *   - **Seal is terminal.** After `seal()` returns, the writer rejects
 *     further `write()` calls and the file ends with a `session_sealed`
 *     record that has been fsync'd to disk. Readers can distinguish
 *     `live` / `sealed-clean` / `sealed-crashed` from the presence (or
 *     absence) of this record.
 *
 * See `docs/philosophy/afk-contract.md` for the contract these writers
 * make enforceable.
 *
 * @module agent/trace/writer
 */

import { createHash } from 'crypto';
import { mkdir, open, writeFile } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { join } from 'path';

import { TraceEventInputSchema } from './events.js';
import type {
  CompactionPayloadInput,
  CompactionPayloadPersisted,
  CompactionSidecarRef,
  SessionSealedPayload,
  TraceEvent,
  TraceEventInput,
} from './types.js';

/** Public interface every trace writer satisfies. */
export interface TraceWriter {
  /** Append a single event. Resolves once the line is on disk (file
   *  writer) or in the buffer (in-memory writer). Rejects if the
   *  writer is sealed. */
  write(event: TraceEventInput): Promise<void>;

  /** Write the terminal `session_sealed` record and close the underlying
   *  resource. Idempotent — subsequent calls resolve to no-op. After
   *  `seal()` returns, `write()` rejects. */
  seal(payload: SessionSealedPayload): Promise<void>;

  /** Close the underlying resource without writing a seal record.
   *  Used by tests and by emergency teardown. A trace closed without
   *  sealing is in `sealed-crashed` state from a reader's view. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// File-backed NDJSON writer
// ---------------------------------------------------------------------------

export interface NdjsonTraceWriterOptions {
  /** Per-session trace directory. Will be created if absent. */
  traceDir: string;
}

/**
 * Append-only NDJSON sink with compaction sidecar support.
 *
 * Implementation notes:
 *
 *   - We open the trace file with `appendFile` semantics via a single
 *     `FileHandle` so the kernel guarantees O_APPEND ordering. Lines
 *     are small (well under PIPE_BUF) — compaction's heavy data goes
 *     to sidecars, not the trace line.
 *   - The internal `writeQueue` is a single-tail promise chain. All
 *     writes go through `enqueue()` so concurrent callers serialize
 *     deterministically.
 *   - `init()` is lazy — the first `write()` creates the directory and
 *     opens the file. This avoids cluttering `~/.afk/state/witness/`
 *     with empty directories for sessions that never emit.
 */
export class NdjsonTraceWriter implements TraceWriter {
  private readonly traceDir: string;
  private readonly tracePath: string;
  private seq = 0;
  private sealed = false;
  private fh: FileHandle | null = null;
  /** Single-tail queue: each enqueued task awaits the previous one,
   *  guaranteeing ordered serialization of writes and inits. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: NdjsonTraceWriterOptions) {
    this.traceDir = options.traceDir;
    this.tracePath = join(this.traceDir, 'trace.jsonl');
  }

  /** Absolute path to the JSONL file this writer appends to. */
  getTracePath(): string {
    return this.tracePath;
  }

  async write(event: TraceEventInput): Promise<void> {
    if (this.sealed) {
      throw new Error('NdjsonTraceWriter: trace is sealed; write() rejected');
    }
    // Validate at the boundary so shape drift never reaches disk.
    TraceEventInputSchema.parse(event);
    return this.enqueue(async () => {
      await this.ensureOpen();
      const persisted = await this.materializePersistedEvent(event);
      await this.appendLine(persisted);
    });
  }

  async seal(payload: SessionSealedPayload): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    await this.enqueue(async () => {
      await this.ensureOpen();
      const persisted: TraceEvent = {
        ts: new Date().toISOString(),
        seq: this.seq++,
        kind: 'session_sealed',
        payload,
      };
      await this.appendLine(persisted);
      // Contract: the seal record must be durably on disk before we
      // hand control back. Otherwise a crash here yields a file that
      // *looks* sealed-clean but isn't.
      if (this.fh) await this.fh.sync();
    });
    await this.closeHandle();
  }

  async close(): Promise<void> {
    // Drain the queue but do not write a seal record. Used by tests
    // and by emergency teardown.
    await this.enqueue(async () => {
      // no-op; the closeHandle below runs after the queue drains
    });
    await this.closeHandle();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    // Chain task onto the queue tail. Use `.then(task, task)` so a
    // rejection in one task does not poison the queue — the next task
    // still runs.
    const next = this.writeQueue.then(task, task);
    // Swallow rejections on the queue tail so an unhandled rejection
    // does not surface; the caller's await on `next` still sees the
    // actual outcome.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureOpen(): Promise<void> {
    if (this.fh) return;
    await mkdir(this.traceDir, { recursive: true });
    // 'a' = append, create if missing. O_APPEND gives ordered writes
    // even across processes (we only have one here, but defense in
    // depth is cheap).
    this.fh = await open(this.tracePath, 'a');
  }

  private async closeHandle(): Promise<void> {
    if (!this.fh) return;
    const fh = this.fh;
    this.fh = null;
    await fh.close();
  }

  private async appendLine(event: TraceEvent): Promise<void> {
    if (!this.fh) throw new Error('NdjsonTraceWriter: file handle missing');
    await this.fh.appendFile(`${JSON.stringify(event)}\n`);
  }

  /**
   * Transform an input event into the persisted form.
   *
   * For most kinds this is a pure header-add (ts, seq). For
   * `compaction`, this also writes the sidecar file holding the
   * full-fidelity pre-compaction message slice and replaces the
   * inline field with a reference.
   */
  private async materializePersistedEvent(
    event: TraceEventInput,
  ): Promise<TraceEvent> {
    const ts = new Date().toISOString();
    const seq = this.seq++;

    if (event.kind === 'compaction') {
      const persistedPayload = await this.persistCompactionSidecar(
        event.payload,
        seq,
        ts,
      );
      return { ts, seq, kind: 'compaction', payload: persistedPayload };
    }

    return { ts, seq, kind: event.kind, payload: event.payload } as TraceEvent;
  }

  /**
   * Write the pre-compaction message slice to a sidecar file and
   * return the persisted payload (inline messages replaced by a
   * reference).
   *
   * Sidecar filename embeds `seq` and a filesystem-safe timestamp so
   * the operator can sort sidecars by emission order and correlate
   * them with the JSONL line.
   */
  private async persistCompactionSidecar(
    payload: CompactionPayloadInput,
    seq: number,
    ts: string,
  ): Promise<CompactionPayloadPersisted> {
    const safeTs = ts.replace(/[:.]/g, '-');
    const sidecarPath = join(
      this.traceDir,
      `${String(seq).padStart(6, '0')}-${safeTs}-pre-compaction.json`,
    );
    const body = JSON.stringify(payload.preCompactionMessages);
    const sizeBytes = Buffer.byteLength(body, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await writeFile(sidecarPath, body, { encoding: 'utf8', flag: 'w' });

    const ref: CompactionSidecarRef = { path: sidecarPath, sizeBytes, sha256 };
    return {
      trigger: payload.trigger,
      preCompactionMessagesRef: ref,
      summary: payload.summary,
      keptTailCount: payload.keptTailCount,
      keepLastNConfig: payload.keepLastNConfig,
      messagesBefore: payload.messagesBefore,
      messagesAfter: payload.messagesAfter,
      ...(payload.tokensSavedEstimate !== undefined
        ? { tokensSavedEstimate: payload.tokensSavedEstimate }
        : {}),
      ...(payload.summarizationTokens !== undefined
        ? { summarizationTokens: payload.summarizationTokens }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory writer (test sink)
// ---------------------------------------------------------------------------

/**
 * In-memory writer for tests and trace replay. Accumulates events in
 * an array reachable via {@link events}. Compaction events are stored
 * with the inline pre-compaction slice intact (no sidecar) — tests can
 * inspect the full fidelity directly.
 *
 * The internal seq counter is owned just like the file writer's, so
 * tests can assert ordering without coupling to wall-clock timestamps.
 */
export class InMemoryTraceWriter implements TraceWriter {
  private seq = 0;
  private sealed = false;
  private readonly _events: TraceEvent[] = [];

  /** Read-only view of accumulated events, in emission order. */
  get events(): readonly TraceEvent[] {
    return this._events;
  }

  async write(event: TraceEventInput): Promise<void> {
    if (this.sealed) {
      throw new Error('InMemoryTraceWriter: trace is sealed; write() rejected');
    }
    TraceEventInputSchema.parse(event);
    const ts = new Date().toISOString();
    const seq = this.seq++;

    if (event.kind === 'compaction') {
      // For tests, fabricate a deterministic-but-fake sidecar ref so the
      // persisted shape matches what readers see on disk. Tests that
      // care about the inline slice can reach into `inlineCompactionMessages`
      // via the side-channel below.
      const body = JSON.stringify(event.payload.preCompactionMessages);
      const sizeBytes = Buffer.byteLength(body, 'utf8');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const persisted: CompactionPayloadPersisted = {
        trigger: event.payload.trigger,
        preCompactionMessagesRef: {
          path: `in-memory://${seq}-pre-compaction.json`,
          sizeBytes,
          sha256,
        },
        summary: event.payload.summary,
        keptTailCount: event.payload.keptTailCount,
        keepLastNConfig: event.payload.keepLastNConfig,
        messagesBefore: event.payload.messagesBefore,
        messagesAfter: event.payload.messagesAfter,
        ...(event.payload.tokensSavedEstimate !== undefined
          ? { tokensSavedEstimate: event.payload.tokensSavedEstimate }
          : {}),
        ...(event.payload.summarizationTokens !== undefined
          ? { summarizationTokens: event.payload.summarizationTokens }
          : {}),
      };
      this._events.push({ ts, seq, kind: 'compaction', payload: persisted });
      this._inlineCompactionPayloads.set(seq, event.payload);
      return;
    }

    this._events.push({ ts, seq, kind: event.kind, payload: event.payload } as TraceEvent);
  }

  async seal(payload: SessionSealedPayload): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    this._events.push({
      ts: new Date().toISOString(),
      seq: this.seq++,
      kind: 'session_sealed',
      payload,
    });
  }

  async close(): Promise<void> {
    // No external resource; sealed state is a runtime flag only.
  }

  // Side-channel for tests that want to inspect the full-fidelity
  // compaction payload (the production writer keeps it on disk; we keep
  // it in memory here).
  private readonly _inlineCompactionPayloads = new Map<number, CompactionPayloadInput>();

  /** Returns the inline pre-compaction payload for the compaction event
   *  at the given seq, or `undefined` if no compaction event was emitted
   *  with that seq. */
  getInlineCompactionPayload(seq: number): CompactionPayloadInput | undefined {
    return this._inlineCompactionPayloads.get(seq);
  }
}
