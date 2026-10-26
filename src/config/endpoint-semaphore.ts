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
  acquire(signal?: AbortSignal): Promise<void>;
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

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Semaphore acquire aborted', 'AbortError'));
    }
    if (this._activeCount < this.limit) {
      this._activeCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const resolver = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        // Splice this resolver out of the queue so the slot is not permanently
        // consumed; release() will not find it and will not mistakenly promote it.
        const idx = this._queue.indexOf(resolver);
        if (idx !== -1) this._queue.splice(idx, 1);
        reject(new DOMException('Semaphore acquire aborted', 'AbortError'));
      };
      this._queue.push(resolver);
      signal?.addEventListener('abort', onAbort, { once: true });
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
 * Not exported — test-only access is via {@link _resetEndpointSemaphores}.
 * Production call-sites use {@link getEndpointSemaphore}.
 * @internal
 */
const _semaphoreRegistry = new Map<string, EndpointSemaphore>();

/**
 * Tracks keys for which a conflicting-limit warning has already been emitted.
 * One-shot per key to avoid log spam across sessions.
 * @internal
 */
const _warnedConflictKeys = new Set<string>();

/**
 * Return the shared semaphore for `baseUrl` at the given `limit`, creating it
 * on first call. Returns `null` when `limit` is falsy (undefined / 0) —
 * the call-site should skip locking entirely, preserving pre-#3886 behaviour.
 *
 * Invariant: once a semaphore is created for a key, its `limit` is fixed for
 * the process lifetime. A subsequent call with a different `limit` for the
 * same key returns the EXISTING semaphore. Operators who change
 * `maxConcurrency` at runtime must restart the process.
 *
 * When two slots share a `baseUrl` with different `maxConcurrency` values,
 * a one-shot `console.warn` is emitted identifying the conflict so operators
 * can diagnose unexpected serialisation behaviour.
 */
export function getEndpointSemaphore(
  baseUrl: string | undefined,
  limit: number | undefined,
): EndpointSemaphore | null {
  if (!limit || !baseUrl) return null;
  const key = normaliseKey(baseUrl);
  const existing = _semaphoreRegistry.get(key);
  if (existing !== undefined) {
    if (existing.limit !== limit && !_warnedConflictKeys.has(key)) {
      _warnedConflictKeys.add(key);
      console.warn(
        `[endpoint-semaphore] Conflicting maxConcurrency for endpoint "${key}": ` +
        `first-registered limit ${existing.limit} will be used (new request was ${limit}). ` +
        `Restart the process to change the limit.`,
      );
    }
    return existing;
  }
  const sem = new CountingSemaphore(limit);
  _semaphoreRegistry.set(key, sem);
  return sem;
}

/**
 * Execute `fn` under the given semaphore (or directly when `sem` is null).
 *
 * Guarantees that `sem.release()` is called exactly once even when `fn`
 * throws or rejects. Returns `fn`'s resolved value. Passes `signal` to
 * `acquire()` so an aborted session does not leak a queued resolver.
 */
export async function withEndpointSemaphore<T>(
  sem: EndpointSemaphore | null,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (sem === null) return fn();
  await sem.acquire(signal);
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

/**
 * Clear all registered semaphores and conflict-warn state.
 * **Test-only** — calling this in production would race with live requests.
 * Named with a leading underscore to make the intent clear.
 * @internal
 */
export function _resetEndpointSemaphores(): void {
  _semaphoreRegistry.clear();
  _warnedConflictKeys.clear();
}
