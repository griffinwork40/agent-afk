import { rmSync } from 'node:fs';

/**
 * Robust directory removal for test teardown.
 *
 * Background git tooling (fsmonitor, git-ai, indexers) can still be writing
 * into `.git/` when a test finishes, causing `rmSync` to throw `ENOTEMPTY`.
 * Retrying with a short delay avoids intermittent teardown failures on
 * developer machines without requiring fake timers or sleep in tests.
 *
 * @param path - Directory (or file) to remove.
 */
export function rmSyncRetry(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
