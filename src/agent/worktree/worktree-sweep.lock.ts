/**
 * Advisory lock for the worktree sweep engine.
 *
 * Extracted from `worktree-sweep.ts` to keep that file within the 350-code-
 * line ceiling. This module owns the process-wide sweep lock lifecycle:
 * acquire (with stale-PID detection), release, and the contested-lock error.
 *
 * Contract: the returned release callback is idempotent — calling it twice is
 * safe (the second unlink() is a no-op). Call it in a `finally` block so the
 * lock is always released even on error.
 *
 * @module agent/worktree/worktree-sweep.lock
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream, existsSync } from 'node:fs';
import { isErrnoCode } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Soft-launch counter
// ---------------------------------------------------------------------------

/**
 * Count prior successful worktree-prune runs recorded in `telemetryPath`.
 * Soft-launch valve: if this count is below SOFT_LAUNCH_RUNS, the sweep runs
 * in dry-run mode regardless of the caller's `dryRun` flag.
 *
 * Contract: counts only records with `taskId === 'worktree-prune'` and status
 * `success` or `error` (both indicate the daemon ran a real sweep pass). A
 * missing file or unreadable record returns 0 — fail-safe.
 */
export async function countPriorSuccessfulRuns(telemetryPath: string): Promise<number> {
  if (!existsSync(telemetryPath)) return 0;
  let count = 0;
  try {
    const rl = createInterface({ input: createReadStream(telemetryPath), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          record['taskId'] === 'worktree-prune' &&
          (record['status'] === 'success' || record['status'] === 'error')
        ) {
          count++;
        }
      } catch { /* malformed line — skip */ }
    }
  } catch { /* file read failure — treat as 0 */ }
  return count;
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

export class LockContestedError extends Error {
  constructor(lockPath: string) {
    super(`Worktree sweep lock contested: ${lockPath} — another sweep may be running.`);
    this.name = 'LockContestedError';
  }
}

/**
 * Acquire the advisory sweep lock at `lockPath`. Returns a release callback
 * that deletes the lock file. Throws `LockContestedError` if a live process
 * already holds the lock.
 *
 * Contract: stale locks (PID no longer alive) are cleared and re-acquired so a
 * crashed sweep never permanently blocks future sweeps.
 */
export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  // Ensure parent directory exists
  const parentDir = join(lockPath, '..');
  await fs.mkdir(parentDir, { recursive: true }).catch(() => {});

  const tryOpen = async (): Promise<import('node:fs/promises').FileHandle> => {
    try {
      return await fs.open(lockPath, 'wx');
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err;

      // Check if PID in existing lock is still alive
      let existingPid: number | null = null;
      try {
        const content = await fs.readFile(lockPath, 'utf-8');
        existingPid = parseInt(content.trim(), 10);
      } catch { /* lock file vanished between checks */ }

      if (existingPid !== null && !Number.isNaN(existingPid)) {
        let alive = false;
        try {
          process.kill(existingPid, 0);
          alive = true;
        } catch { /* process gone — stale lock */ }
        if (!alive) {
          await fs.unlink(lockPath).catch(() => {});
          return await fs.open(lockPath, 'wx');
        }
      }
      throw new LockContestedError(lockPath);
    }
  };

  const handle = await tryOpen();
  await handle.writeFile(String(process.pid), 'utf-8');
  await handle.close();

  return async () => { await fs.unlink(lockPath).catch(() => {}); };
}
