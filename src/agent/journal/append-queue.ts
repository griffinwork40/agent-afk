/**
 * Small write-path primitives for the message journal.
 *
 *   - {@link SerialQueue}: runs async tasks strictly in push order. A failing
 *     task is reported and the queue moves on, so one bad write never stalls
 *     the ones behind it (the journal must never wedge a session).
 *   - {@link JsonlFileAppender}: O_APPEND writes to one JSONL file, creating
 *     the parent dir (0700) and the file (0600) on first write. If the dir
 *     vanishes later (a sweep in another process, a manual `rm`), the ENOENT
 *     write recreates it and retries once instead of failing forever.
 *   - {@link createOnceReporter}: the ledger's error posture (stderr, once).
 *
 * Invariant: the appender does NOT hold a file descriptor between writes.
 * Each write is `open(O_APPEND) + write + close`. A session can spawn many
 * subagent journals whose owners may never call `close()`; a long-lived fd
 * per journal would leak. Journal records are per-message (low rate), so the
 * extra open/close is noise.
 *
 * @module agent/journal/append-queue
 */

import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';

import { errorMessage, isErrnoCode} from '../../utils/errors.js';

export type OnceReporter = (what: string, err?: unknown) => void;

/** stderr reporter that prints its first call only (mirrors session-ledger.ts). */
export function createOnceReporter(label: string): OnceReporter {
  let reported = false;
  return (what, err) => {
    if (reported) return;
    reported = true;
    const suffix = err === undefined ? '' : `: ${errorMessage(err)}`;
    try {
      process.stderr.write(`[afk] ${label}: ${what}${suffix} (further reports suppressed)\n`);
    } catch {
      // stderr closed: nothing left to tell.
    }
  };
}

/** Strictly ordered async task runner. `idle()` resolves once all pushed tasks settle. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err: unknown) => {
      try {
        this.onError(err);
      } catch {
        // Reporter must never break the chain.
      }
    });
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/** Appends pre-serialized lines to one file. Callers serialize via a {@link SerialQueue}. */
export class JsonlFileAppender {
  private dirReady = false;

  constructor(readonly path: string) {}

  async write(data: string): Promise<void> {
    await this.ensureDir();
    try {
      await this.append(data);
    } catch (err) {
      if (!isErrnoCode(err, 'ENOENT')) throw err;
      // The dir was removed under us: recreate it and retry once.
      this.dirReady = false;
      await this.ensureDir();
      await this.append(data);
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await fsp.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.dirReady = true;
  }

  private append(data: string): Promise<void> {
    return fsp.appendFile(this.path, data, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
}
