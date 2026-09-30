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
 *
 * @internal
 */
export const READAHEAD_CONCURRENCY = 32;

type ReaddirResult = Dirent[];

/**
 * Promise-based bounded read-ahead cache for `readdir` results.
 *
 * **Single-use contract**: each {@link Readahead} instance is intended for one
 * walk lifetime. Calling {@link drain} and then {@link schedule}/{@link get}
 * again is not supported — the epoch guard below detects this and silently
 * ignores stale {@link finally} callbacks so `inFlight` never goes negative.
 *
 * Usage pattern in the walker:
 * ```
 * const ra = new Readahead(32, signal);
 * // … on entry into a directory:
 * ra.schedule(childPath);       // kick off I/O now
 * // … later, when actually walking that directory:
 * const entries = await ra.get(childPath); // instant if I/O already done
 * // … after the walk finishes:
 * ra.drain();                   // drop cached promises so GC can collect them
 * ```
 *
 * @internal
 */
export class Readahead {
  // Readonly configuration — set at construction and never mutated.
  private readonly maxConcurrent: number;
  private readonly signal: AbortSignal | undefined;

  // Mutable state — mutated on every schedule/get/drain call.
  /** Pending or resolved reads keyed by absolute directory path. */
  private readonly cache = new Map<string, Promise<ReaddirResult>>();
  /** Count of I/O calls in flight (resolved promises still count until get). */
  private inFlight = 0;
  /**
   * Epoch counter incremented on every {@link drain} call.
   * Each scheduled promise captures the current epoch; its {@link finally}
   * callback is a no-op when the epoch has advanced (i.e. drain was called
   * after the promise was launched but before it settled). This prevents the
   * inFlight counter from going negative if a Readahead instance were ever
   * reused after a drain().
   */
  private epoch = 0;

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
   * When the concurrency budget is exhausted, the schedule call is a silent
   * no-op. The walker's {@link get} will then issue a fresh direct readdir.
   *
   * Called by the walker when it decides a directory is worth entering
   * (denylist + prune checks passed). The result is cached for {@link get}.
   */
  schedule(dirPath: string): void {
    if (this.cache.has(dirPath)) return;
    if (this.signal?.aborted) return;
    // When concurrency is saturated, the walker falls back to a direct readdir
    // in get(). This is the over-cap path — intentional, not an error.
    if (this.inFlight >= this.maxConcurrent) return;

    this.inFlight++;
    const capturedEpoch = this.epoch;
    const p = fs
      .readdir(dirPath, { withFileTypes: true })
      // Unreadable dirs (e.g. permission denied) return an empty listing.
      // This is safe because the entry-level denylist already filtered out
      // known-protected paths before schedule() was called; any remaining
      // EACCES here is an OS-level restriction beyond our control.
      .catch((): ReaddirResult => [])
      .finally(() => {
        // Guard against epoch mismatch: if drain() was called between when
        // this promise was launched and when it settled, don't decrement
        // inFlight — it was already reset to 0 by drain().
        if (this.epoch === capturedEpoch) {
          this.inFlight--;
        }
      });
    this.cache.set(dirPath, p);
  }

  /**
   * Retrieve the `readdir` result for `dirPath` and evict it from the cache.
   *
   * If a prior {@link schedule} call queued a read, the promise is awaited
   * (may already be resolved). If no read was scheduled (concurrency was
   * exhausted when `schedule()` was called, so the call was a no-op), a fresh
   * `readdir` is issued directly here — this is the over-cap fallback path.
   *
   * Returns `[]` on any I/O error (inaccessible directory).
   *
   * Note: the cache entry is deleted on first await, so each path is
   * retrieved at most once (evict-on-get). This matches the walker's
   * single-visit-per-directory invariant.
   */
  async get(dirPath: string): Promise<ReaddirResult> {
    const cached = this.cache.get(dirPath);
    if (cached) {
      // Evict immediately so the resolved promise is not held in memory
      // beyond the point where the walker processes this directory.
      this.cache.delete(dirPath);
      return cached;
    }

    // Over-cap fallback: no prior schedule() call succeeded (concurrency was
    // saturated). Issue a fresh direct readdir now.
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      // Narrow to genuine Node.js filesystem errors before swallowing.
      // Contract: only errors that are `instanceof Error` with a string `.code`
      // property (i.e. `NodeJS.ErrnoException`) are treated as expected I/O
      // denials and mapped to an empty listing. All other thrown values —
      // including DOMException, AbortError, mocks with a `.code` property that
      // is not actually a Node.js errno, and bare non-Error objects — are
      // re-thrown so the caller can distinguish I/O denials from programming
      // errors.
      //
      // This mirrors the narrowing pattern in `_fs-error.ts`:
      //   `if (!(err instanceof Error)) return undefined;`
      //   `const code = (err as Error & { code?: string }).code;`
      if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Drop all cached promises after the walk finishes or is aborted.
   * Allows GC to collect outstanding promise chains.
   *
   * Advances the internal epoch so any still-pending {@link finally} callbacks
   * from in-flight reads become no-ops and do not decrement `inFlight` below
   * zero. This makes {@link Readahead} safe even if a caller accidentally
   * reuses the instance (though single-use is the intended contract).
   */
  drain(): void {
    this.cache.clear();
    this.inFlight = 0;
    this.epoch++;
  }
}
