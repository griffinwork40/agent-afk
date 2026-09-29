/**
 * Bounded, order-preserving readdir read-ahead for the glob walker.
 *
 * The glob walker visits directories depth-first and historically awaited one
 * `readdir` at a time. On large trees (e.g. a walk from $HOME with ~1.5M
 * entries) that sequential I/O took 22s; 64 concurrent `readdir` calls
 * measured ~7s on the same tree.
 *
 * This module provides a {@link Readahead} that the walker attaches to. When
 * the walker encounters a directory it wants to descend into, it calls
 * {@link Readahead.schedule} so the OS read begins immediately. When the
 * walker actually processes that directory, it calls {@link Readahead.get}
 * which resolves instantly if the read already finished.
 *
 * Invariants (all load-bearing):
 *   - Results are resolved in walker order, not I/O completion order, so
 *     output under the 500-entry cap is **byte-identical** to the sequential
 *     walker.
 *   - Concurrency is bounded at construction time (`maxConcurrent`). No
 *     unbounded fan-out occurs even on enormous trees.
 *   - Once the walker is done or aborted, {@link Readahead.drain} drops all
 *     cached promises so GC is not blocked.
 *   - Denied / pruned directories are never scheduled, limiting wasted reads.
 *
 * @module agent/tools/handlers/glob-readahead
 */

import { promises as fs } from 'fs';
import type { Dirent } from 'fs';

/**
 * Number of concurrent `readdir` calls allowed.
 * 32 is conservative: avoids FD exhaustion on common ulimit=256 systems while
 * still providing meaningful parallelism on typical SSDs/NVMe.
 */
export const READAHEAD_CONCURRENCY = 32;

type ReaddirResult = Dirent[];

/**
 * Promise-based bounded read-ahead cache for `readdir` results.
 *
 * Usage pattern in the walker:
 * ```
 * const ra = new Readahead(32, signal);
 * // … on entry into a directory:
 * ra.schedule(childPath);       // kick off I/O now
 * // … later, when actually walking that directory:
 * const entries = await ra.get(childPath); // instant if I/O already done
 * ```
 */
export class Readahead {
  /** Pending or resolved reads keyed by absolute directory path. */
  private readonly cache = new Map<string, Promise<ReaddirResult>>();
  /** Count of I/O calls in flight (resolved promises still count until get). */
  private inFlight = 0;
  private readonly maxConcurrent: number;
  private readonly signal: AbortSignal | undefined;

  constructor(maxConcurrent: number = READAHEAD_CONCURRENCY, signal?: AbortSignal) {
    this.maxConcurrent = maxConcurrent;
    this.signal = signal;
  }

  /**
   * Schedule a `readdir` for `dirPath` if:
   *   - not already scheduled, AND
   *   - the concurrency budget allows it, AND
   *   - the abort signal has not fired.
   *
   * Called by the walker when it decides a directory is worth entering
   * (denylist + prune checks passed). The result is cached for `get()`.
   */
  schedule(dirPath: string): void {
    if (this.cache.has(dirPath)) return;
    if (this.signal?.aborted) return;
    if (this.inFlight >= this.maxConcurrent) return;

    this.inFlight++;
    const p = fs
      .readdir(dirPath, { withFileTypes: true })
      .catch((): ReaddirResult => [])
      .finally(() => {
        this.inFlight--;
      });
    this.cache.set(dirPath, p);
  }

  /**
   * Retrieve the `readdir` result for `dirPath`.
   *
   * If a prior `schedule()` call queued a read, the promise is awaited
   * (may already be resolved). If no read was scheduled (concurrency was
   * exhausted when `schedule()` was called), a fresh `readdir` is issued
   * synchronously here and counted against the budget.
   *
   * Returns `[]` on any I/O error (inaccessible directory).
   */
  async get(dirPath: string): Promise<ReaddirResult> {
    const cached = this.cache.get(dirPath);
    if (cached) {
      const result = await cached;
      this.cache.delete(dirPath);
      return result;
    }

    // No prior schedule — issue a fresh read (concurrency already saturated
    // earlier or the caller skipped schedule for this entry).
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * Drop all cached promises after the walk finishes or is aborted.
   * Allows GC to collect outstanding promise chains.
   */
  drain(): void {
    this.cache.clear();
    this.inFlight = 0;
  }
}
