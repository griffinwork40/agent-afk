/**
 * Persistent JSONL logging for background subagent jobs.
 *
 * Two classes:
 *
 *   - `BgJobLogWriter` — opened per-job in `BackgroundAgentRegistry.register()`.
 *     Writes every `OutputEvent` to `~/.afk/state/bg/<jobId>/events.jsonl` and
 *     atomically updates `meta.json` at start and end.
 *
 *   - `BgJobLogReader` — read-only surface used by `afk bg` CLI commands and
 *     by the `/bgsub:join` fallback path when a job has been evicted from memory.
 *
 * Design:
 *   - The writer uses a lazy append stream (created on first write) so zero-event
 *     jobs don't leave empty files.
 *   - Disk errors are caught and suppressed on the write path — a bg job must
 *     never fail because the log directory is full or unwritable.
 *   - `tailEvents` uses polling (250ms) with `fs.watch` as primary fallback,
 *     stopping when meta.status is terminal AND all bytes have been read.
 *   - Job directories older than 7 days are swept by `BackgroundAgentRegistry`
 *     on startup. The reader handles ENOENT gracefully on all paths.
 *
 * @module agent/bg-job-log
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { getBgJobsRoot, getBgJobDir, getBgJobLog, getBgJobMeta } from '../paths.js';
import type { OutputEvent } from './types/session-types.js';

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

export interface BgJobMeta {
  jobId: string;
  subagentId: string;
  label: string;
  /** SHA-256 hex of the original prompt. Full prompt text is never written to disk. */
  promptHash: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  parentSessionId?: string;
  schemaVersion: 1;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class BgJobLogWriter {
  private readonly jobId: string;
  private readonly logPath: string;
  private readonly metaPath: string;
  private stream: fs.WriteStream | null = null;
  private errored = false;
  private closed = false;
  private streamReady = false;
  /** Queued lines waiting for the stream's 'open' event. */
  private pendingLines: string[] = [];
  /**
   * Promise that resolves once the stream is ready (or errored).
   * Used by close() to ensure all pending lines are flushed.
   */
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  /**
   * Serializes concurrent writeMeta calls. Each call chains onto this
   * promise so the last write wins and all writes are in registration order.
   */
  private metaWriteQueue: Promise<void> = Promise.resolve();

  constructor(jobId: string) {
    this.jobId = jobId;
    this.logPath = getBgJobLog(jobId);
    this.metaPath = getBgJobMeta(jobId);
    // Create directory eagerly so writeMeta works even before the first write().
    try {
      fs.mkdirSync(getBgJobDir(jobId), { recursive: true });
    } catch (e) {
      process.stderr.write(`[afk] bg-job-log: mkdir failed for ${jobId}: ${String(e)}\n`);
      this.errored = true;
    }
  }

  /**
   * Serialize and append an OutputEvent as a JSONL line.
   * Silently no-ops when the writer has errored or is closed.
   */
  write(event: OutputEvent): void {
    if (this.errored || this.closed) return;
    const line = JSON.stringify(event) + '\n';
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

  private _openStream(): void {
    if (this.stream) return; // already opening
    // Create a ready-promise so close() can await stream initialization.
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    try {
      const s = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
      this.stream = s;
      s.once('open', () => {
        this.streamReady = true;
        for (const line of this.pendingLines) {
          this._writeLine(line);
        }
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
      s.once('error', (err) => {
        process.stderr.write(`[afk] bg-job-log: stream error for ${this.jobId}: ${String(err)}\n`);
        this.errored = true;
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
    } catch (e) {
      process.stderr.write(`[afk] bg-job-log: createWriteStream failed for ${this.jobId}: ${String(e)}\n`);
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
          process.stderr.write(`[afk] bg-job-log: write error for ${this.jobId}: ${String(err)}\n`);
          this.errored = true;
        }
      });
    } catch (e) {
      process.stderr.write(`[afk] bg-job-log: write threw for ${this.jobId}: ${String(e)}\n`);
      this.errored = true;
    }
  }

  /** Flush and close the write stream. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Wait for stream initialization if it's still pending
    if (this.readyPromise) {
      await this.readyPromise;
    }

    return new Promise<void>((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(() => {
        resolve();
      });
    });
  }

  /**
   * Atomically write metadata: write to `<path>.<rand>.tmp`, then rename to final.
   * Calls are serialized via a queue so the last enqueued write wins even if
   * two callers fire concurrently — the terminal-status update always lands after
   * the initial running-status write. Catches and logs errors; never throws.
   */
  async writeMeta(meta: BgJobMeta): Promise<void> {
    // Serialize by chaining onto the queue. Each invocation waits for the
    // previous to complete before running its own I/O.
    this.metaWriteQueue = this.metaWriteQueue.then(() => this._writeMetaInner(meta));
    await this.metaWriteQueue;
  }

  private async _writeMetaInner(meta: BgJobMeta): Promise<void> {
    const tmpPath = `${this.metaPath}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmpPath, this.metaPath);
    } catch (e) {
      process.stderr.write(`[afk] bg-job-log: writeMeta failed for ${this.jobId}: ${String(e)}\n`);
      // Best-effort cleanup of tmp file
      try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class BgJobLogReader {
  /** List all jobs from disk, sorted by startedAt desc, max 100. */
  static async listJobs(): Promise<BgJobMeta[]> {
    const root = getBgJobsRoot();
    let entries: string[];
    try {
      entries = await fsp.readdir(root);
    } catch {
      return [];
    }

    const metas: BgJobMeta[] = [];
    // Read all entries before sorting — readdir returns names in arbitrary
    // filesystem order, so slicing before sort could exclude newer jobs that
    // happen to have high inode numbers. Safety cap at 1000 to bound I/O.
    for (const entry of entries.slice(0, 1000)) {
      const meta = await BgJobLogReader.readMeta(entry);
      if (meta) metas.push(meta);
    }

    metas.sort((a, b) => b.startedAt - a.startedAt);
    return metas.slice(0, 100);
  }

  /**
   * Read a single job's meta.json.
   * Returns null on invalid jobId, ENOENT, parse error, or schema mismatch.
   *
   * Path traversal is rejected by `getBgJobMeta` → `assertSafeJobId` (see
   * `paths.ts`); the throw is caught here and converted to `null` to preserve
   * the legacy "not found" UX. Callers that need to distinguish "invalid id"
   * from "missing file" should call `assertSafeJobId` directly.
   */
  static async readMeta(jobId: string): Promise<BgJobMeta | null> {
    let metaPath: string;
    try {
      metaPath = getBgJobMeta(jobId);
    } catch {
      // Invalid jobId (path traversal, bad charset, etc.) — treat as not found.
      return null;
    }
    try {
      const raw = await fsp.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as BgJobMeta;
      // Reject files with an unexpected schema version (stale v0, future v2, etc.)
      if (parsed.schemaVersion !== 1) return null;
      return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corrupted meta — log and return null
      process.stderr.write(`[afk] bg-job-log: readMeta parse error for ${jobId}: ${String(e)}\n`);
      return null;
    }
  }

  /**
   * Read all events from a completed job's JSONL log.
   * Yields each event in order. Handles ENOENT gracefully (zero events).
   */
  static async *readEvents(jobId: string): AsyncGenerator<OutputEvent> {
    const logPath = getBgJobLog(jobId);
    let fd: fs.promises.FileHandle;
    try {
      fd = await fsp.open(logPath, 'r');
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
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as OutputEvent;
        } catch {
          // Skip malformed lines
        }
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Tail events from a job's log — for live following.
   *
   * - If `fromStart` is true, first replays all existing lines.
   * - Then polls for new content (250ms interval) until the job's meta.status
   *   is terminal AND all bytes in the file have been read.
   * - Uses `fs.watch` as primary wakeup, polling as fallback.
   */
  static async *tailEvents(
    jobId: string,
    opts?: { fromStart?: boolean },
  ): AsyncGenerator<OutputEvent> {
    const logPath = getBgJobLog(jobId);
    const { fromStart = false } = opts ?? {};

    // Ensure the job dir exists; if not, nothing to tail.
    const jobDir = getBgJobDir(jobId);
    try {
      await fsp.access(jobDir);
    } catch {
      return;
    }

    let fileOffset = 0;
    let buffer = '';
    let watcher: fs.FSWatcher | null = null;

    const POLL_INTERVAL_MS = 250;

    // Helper: read new bytes from the file starting at fileOffset
    async function* readNewLines(): AsyncGenerator<OutputEvent> {
      let fd: fs.promises.FileHandle | null = null;
      try {
        fd = await fsp.open(logPath, 'r');
        const stat = await fd.stat();
        if (stat.size <= fileOffset) return;
        const toRead = stat.size - fileOffset;
        const readBuf = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await fd.read(readBuf, 0, toRead, fileOffset);
        if (bytesRead === 0) return;
        fileOffset += bytesRead;
        buffer += readBuf.toString('utf8', 0, bytesRead);
        const lines = buffer.split('\n');
        // Keep the last incomplete fragment in the buffer
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield JSON.parse(trimmed) as OutputEvent;
          } catch {
            // Skip malformed lines
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write(`[afk] bg-job-log: tailEvents read error for ${jobId}: ${String(e)}\n`);
        }
      } finally {
        if (fd) await fd.close().catch(() => { /* ignore */ });
      }
    }

    /** Check if we're done: meta is terminal AND we've read all bytes. */
    async function isDone(): Promise<boolean> {
      const meta = await BgJobLogReader.readMeta(jobId);
      if (!meta) return false;
      const isTerminal = meta.status !== 'running';
      if (!isTerminal) return false;
      // Check if we've consumed all bytes
      try {
        const stat = await fsp.stat(logPath);
        return fileOffset >= stat.size;
      } catch {
        return true; // file gone = nothing more to read
      }
    }

    // Replay history if requested
    if (fromStart) {
      yield* readNewLines();
    } else {
      // Skip existing content — advance fileOffset to current end
      try {
        const stat = await fsp.stat(logPath);
        fileOffset = stat.size;
      } catch {
        // File doesn't exist yet; start from 0
      }
    }

    // Check if already done before setting up watcher
    if (await isDone()) return;

    // Set up fs.watch for efficient wake-up
    let watcherChange: (() => void) | null = null;
    let watcherResolve: (() => void) | null = null;

    const waitForChange = (): Promise<void> =>
      new Promise<void>((resolve) => {
        watcherResolve = resolve;
        // Poll fallback fires after POLL_INTERVAL_MS regardless
        const pollTimer = setTimeout(() => {
          watcherResolve = null;
          resolve();
        }, POLL_INTERVAL_MS);
        // If watcherChange was set by the watcher callback, it resolves early
        watcherChange = () => {
          clearTimeout(pollTimer);
          watcherResolve = null;
          resolve();
        };
      });

    try {
      watcher = fs.watch(jobDir, { persistent: false }, () => {
        watcherChange?.();
        watcherChange = null;
      });
    } catch {
      // fs.watch may fail on some platforms; fall back to pure polling
    }

    try {
      while (true) {
        await waitForChange();
        yield* readNewLines();
        if (await isDone()) break;
      }
    } finally {
      // Cast needed: TS narrows watcherResolve to 'never' after seeing it set
      // to null inside closures, but it may still hold a pending resolve.
      (watcherResolve as (() => void) | null)?.();
      watcher?.close();
    }
  }
}
