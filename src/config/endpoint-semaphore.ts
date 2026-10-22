/**
 * Per-endpoint concurrency semaphore registry.
 *
 * Implements the "keyed by resolved endpoint" design from issue #3886: two
 * model slots that share the same `baseUrl` (e.g. a local single-request
 * server) share one semaphore, so their concurrent model requests are serialised
 * together rather than independently.
 *
 * ### Usage
 *
 * ```ts
 * const sem = getEndpointSemaphore(baseUrl, maxConcurrency);
 * await sem.acquire();
 * try {
 *   await callModel();
 * } finally {
 *   sem.release();
 * }
 * ```
 *
 * ### Backward compatibility
 *
 * When `maxConcurrency` is `undefined` or `0`, {@link getEndpointSemaphore}
 * returns `null`, meaning no semaphore is installed and the call-site passes
 * through identically to the pre-#3886 behaviour.
 *
 * ### Key normalisation
 *
 * The semaphore key is the normalised `baseUrl` (trimmed, trailing slash
 * stripped, lower-cased). Two slots that differ only by trailing slash or
 * casing share one semaphore — the intended behaviour for a shared local
 * server.
 *
 * ### Process-global registry
 *
 * The registry lives at module scope. Semaphores are created on first
 * reference and reused across sessions, matching the intended invariant: all
 * concurrent model requests to the same endpoint contend on the same counter
 * regardless of which session issued them.
 *
 * @module config/endpoint-semaphore
 */

/** A minimal counting semaphore. */
export interface EndpointSemaphore {
  /** Block until a slot is available, then claim it. */
  acquire(): Promise<void>;
  /** Release one slot. Must be called exactly once per successful `acquire()`. */
  release(): void;
  /** Current number of active holders (for observability / tests). */
  readonly activeCount: number;
  /** Configured limit. */
  readonly limit: number;
}

class CountingSemaphore implements EndpointSemaphore {
  private _activeCount = 0;
  private readonly _queue: Array<() => void> = [];

  constructor(readonly limit: number) {}

  get activeCount(): number {
    return this._activeCount;
  }

  acquire(): Promise<void> {
    if (this._activeCount < this.limit) {
      this._activeCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next !== undefined) {
      // A waiter is promoted without changing _activeCount: we hand the
      // slot directly to the next waiter rather than decrement then re-increment.
      next();
    } else {
      this._activeCount -= 1;
    }
  }
}

/** Normalise a baseUrl to a stable semaphore key. */
function normaliseKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Process-global semaphore registry keyed by normalised endpoint URL.
 *
 * Exported only for test-hygiene (resetEndpointSemaphores). Do NOT reference
 * directly from production call-sites; use {@link getEndpointSemaphore}.
 * @internal
 */
export const _semaphoreRegistry = new Map<string, EndpointSemaphore>();

/**
 * Return the shared semaphore for `baseUrl` at the given `limit`, creating it
 * on first call. Returns `null` when `limit` is falsy (undefined / 0) —
 * the call-site should skip locking entirely, preserving pre-#3886 behaviour.
 *
 * Invariant: once a semaphore is created for a key, its `limit` is fixed for
 * the process lifetime. A subsequent call with a different `limit` for the
 * same key returns the EXISTING semaphore. Operators who change
 * `maxConcurrency` at runtime must restart the process.
 */
export function getEndpointSemaphore(
  baseUrl: string | undefined,
  limit: number | undefined,
): EndpointSemaphore | null {
  if (!limit || !baseUrl) return null;
  const key = normaliseKey(baseUrl);
  const existing = _semaphoreRegistry.get(key);
  if (existing !== undefined) return existing;
  const sem = new CountingSemaphore(limit);
  _semaphoreRegistry.set(key, sem);
  return sem;
}

/**
 * Execute `fn` under the given semaphore (or directly when `sem` is null).
 *
 * Guarantees that `sem.release()` is called exactly once even when `fn`
 * throws or rejects. Returns `fn`'s resolved value.
 */
export async function withEndpointSemaphore<T>(
  sem: EndpointSemaphore | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (sem === null) return fn();
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

/**
 * Clear all registered semaphores. **Test-only** — calling this in production
 * would race with live requests. Named with a leading underscore to make the
 * intent clear.
 * @internal
 */
export function _resetEndpointSemaphores(): void {
  _semaphoreRegistry.clear();
}
