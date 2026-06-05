/**
 * Zero-arg and TTL-based memoization utilities.
 * No external dependencies.
 */

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result;
  cache: { clear: () => void };
};

/** Cache the result of a zero-arg function after the first call. */
export function memoizeSimple<T>(fn: () => T): () => T {
  let cached: T | undefined;
  let hasCached = false;
  return () => {
    if (!hasCached) {
      cached = fn();
      hasCached = true;
    }
    return cached as T;
  };
}

/** Memoize with a TTL (default 5 min). Stale entries are refreshed in the background. */
export function memoizeWithTTL<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  ttlMs: number = 300_000,
): MemoizedFunction<Args, Result> {
  const store = new Map<string, { value: Result; timestamp: number; refreshing: boolean }>();

  const memoized = ((...args: Args): Result => {
    const key = JSON.stringify(args);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry) {
      const value = fn(...args);
      store.set(key, { value, timestamp: now, refreshing: false });
      return value;
    }

    if (now - entry.timestamp <= ttlMs) {
      return entry.value;
    }

    // Stale — schedule background refresh and return stale value
    if (!entry.refreshing) {
      entry.refreshing = true;
      Promise.resolve().then(() => {
        try {
          const fresh = fn(...args);
          store.set(key, { value: fresh, timestamp: Date.now(), refreshing: false });
        } catch {
          store.delete(key);
        }
      });
    }

    return entry.value;
  }) as MemoizedFunction<Args, Result>;

  memoized.cache = { clear: () => store.clear() };
  return memoized;
}
