/**
 * Minimal async mutual-exclusion primitive for the LSP subsystem.
 *
 * `AsyncMutex` serialises callers: each `acquire()` call returns a release
 * callback; subsequent callers queue behind the current holder. Releasing
 * inside a `finally` block is the recommended pattern:
 *
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 *
 * @module agent/lsp/async-mutex
 */

/** A single-entry async mutex (binary semaphore). */
export class AsyncMutex {
  /** Resolvers for waiters queued behind the current holder. */
  private _waiters: Array<() => void> = [];
  private _locked = false;

  /** True when the lock is held or at least one caller is queued. */
  get isLocked(): boolean { return this._locked || this._waiters.length > 0; }

  /**
   * Acquire the lock. Resolves immediately when free; queues when held.
   * Returns a release callback — call it exactly once, in a `finally` block.
   */
  acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve(() => this._release());
    }
    return new Promise<() => void>((resolve) => {
      this._waiters.push(() => {
        // _locked is already true when we dequeue; hand the release fn to the
        // next waiter without toggling _locked.
        resolve(() => this._release());
      });
    });
  }

  private _release(): void {
    const next = this._waiters.shift();
    if (next) {
      // Wake the next waiter on the microtask queue so the current holder's
      // finally block finishes before the next holder begins.
      void Promise.resolve().then(next);
    } else {
      this._locked = false;
    }
  }
}

/**
 * Registry of mutexes keyed by an arbitrary string, created on first use.
 * Useful for per-path or per-(client,uri) serialisation.
 */
export class MutexRegistry {
  private readonly _map = new Map<string, AsyncMutex>();

  /** Return (creating if needed) the mutex for `key`. */
  get(key: string): AsyncMutex {
    let m = this._map.get(key);
    if (!m) { m = new AsyncMutex(); this._map.set(key, m); }
    return m;
  }

  /** Number of tracked keys (for tests / diagnostics). */
  get size(): number { return this._map.size; }

  /**
   * Delete the mutex for `key` if it is currently idle (not locked, no
   * waiters). Call after releasing a lock to reclaim memory for ephemeral
   * keys. No-op when the key is absent or the mutex is still in use.
   */
  releaseIfIdle(key: string): void {
    const m = this._map.get(key);
    if (m && !m.isLocked) this._map.delete(key);
  }
}
