/**
 * Single-instance guard for the afk daemon.
 *
 * Prevents two daemon processes from running concurrently on the same machine
 * by acquiring an O_EXCL PID lockfile at startup. Stale locks left by a
 * SIGKILL'd daemon are detected via `process.kill(pid, 0)` and cleared
 * automatically so a crash never permanently blocks future starts.
 *
 * # Design
 *
 * The lock file lives at `<getDaemonStateDir('default')>/daemon.lock` and
 * contains the owning process's PID as a decimal string. Acquisition uses
 * `open(path, 'wx')` (O_CREAT | O_EXCL) which is atomic on POSIX and NTFS
 * — only one concurrent opener wins; all others get EEXIST.
 *
 * This module is intentionally a thin wrapper over the same pattern used by
 * the worktree-sweep advisory lock (`worktree-sweep.lock.ts`). It differs in
 * two ways:
 *   1. The error type is `DaemonAlreadyRunningError` (vs `LockContestedError`)
 *      so callers can distinguish a daemon-level guard from a sweep-level one.
 *   2. The lock path is derived from `getDaemonStateDir` (daemon state dir)
 *      rather than being caller-supplied, because there is exactly one
 *      per-instance daemon lock.
 *
 * # SIGKILL safety
 *
 * A `kill -9`'d daemon cannot run its `stop()` cleanup. The stale lock file
 * persists until the next `startDaemon()` call detects that the recorded PID
 * is dead and removes it. This is the same "stale-PID detection" pattern used
 * by the sweep lock — no additional mechanism is needed.
 *
 * @module agent/daemon-instance.lock
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getDaemonStateDir } from '../paths.js';
import { isErrnoCode, isWindowsLockContention } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by `acquireDaemonLock` when a live daemon process already owns the
 * lock. Callers should treat this as a non-retriable startup failure and exit
 * with a clear user-facing message.
 */
export class DaemonAlreadyRunningError extends Error {
  /** PID of the live daemon that holds the lock, when determinable. */
  readonly ownerPid: number | null;

  constructor(lockPath: string, ownerPid: number | null) {
    const pidClause =
      ownerPid !== null ? ` (owned by PID ${ownerPid})` : '';
    super(
      `Another afk daemon is already running${pidClause}. ` +
        `Lock file: ${lockPath}. ` +
        `Stop the existing daemon before starting a new one.`,
    );
    this.name = 'DaemonAlreadyRunningError';
    this.ownerPid = ownerPid;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The path at which the daemon instance lock is written.
 *
 * Exported so tests can inject a tmp-dir override and so the CLI can surface
 * it in diagnostic messages.
 */
export function getDaemonLockPath(instanceId: string = 'default'): string {
  return join(getDaemonStateDir(instanceId), 'daemon.lock');
}

/**
 * Acquire the daemon-level single-instance lock.
 *
 * Returns a `release` callback that removes the lock file. Call it in a
 * `finally` / `stop()` handler so the lock is always relinquished on
 * graceful shutdown.
 *
 * The returned release callback is **idempotent** — safe to call multiple
 * times (subsequent calls are no-ops).
 *
 * @throws {DaemonAlreadyRunningError} when a live daemon process holds the
 *   lock.
 * @throws {NodeJS.ErrnoException} for unexpected filesystem errors (EACCES,
 *   ENOSPC, etc.).
 *
 * @param lockPath - Override the lock file path (tests only).
 * @param platform - Override `process.platform` (tests only).
 */
export async function acquireDaemonLock(
  lockPath: string = getDaemonLockPath(),
  platform: string = process.platform,
): Promise<() => Promise<void>> {
  // Ensure the parent directory exists before trying to open the lock file.
  const parentDir = join(lockPath, '..');
  await fs.mkdir(parentDir, { recursive: true }).catch(() => {});

  const handle = await tryOpen(lockPath, platform);

  await handle.writeFile(String(process.pid), 'utf-8');
  await handle.close();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.unlink(lockPath).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Attempt to open the lock file with O_CREAT | O_EXCL (atomic exclusive
 * create). On EEXIST, check whether the recorded PID is still alive:
 *   - alive  → throw `DaemonAlreadyRunningError`
 *   - dead   → delete stale lock, retry once
 */
async function tryOpen(
  lockPath: string,
  platform: string,
): Promise<import('node:fs/promises').FileHandle> {
  try {
    return await fs.open(lockPath, 'wx');
  } catch (err) {
    if (!isErrnoCode(err, 'EEXIST') && !isWindowsLockContention(err, platform)) throw err;

    // Read the PID from the existing lock file.
    let ownerPid: number | null = null;
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      const parsed = parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed)) ownerPid = parsed;
    } catch {
      // Lock file vanished between open() and readFile() — another process may
      // have won the race and released already. Fall through to retry.
    }

    // If we read a PID, check whether that process is still alive.
    if (ownerPid !== null) {
      let alive = false;
      try {
        process.kill(ownerPid, 0);
        alive = true;
      } catch {
        // ESRCH — process is gone; stale lock.
      }

      if (alive) {
        throw new DaemonAlreadyRunningError(lockPath, ownerPid);
      }

      // Stale lock — remove it and retry once.
      await fs.unlink(lockPath).catch(() => {});
    }

    // Retry once after clearing the stale lock (or if the lock file vanished
    // on its own between our open() and readFile() calls above).
    try {
      return await fs.open(lockPath, 'wx');
    } catch (retryErr) {
      if (!isErrnoCode(retryErr, 'EEXIST') && !isWindowsLockContention(retryErr, platform)) {
        throw retryErr;
      }
      // Lost the race on retry — another process acquired it between our unlink
      // and our retry open. Re-read the new owner PID for the error message.
      let retryOwnerPid: number | null = null;
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const parsed = parseInt(raw.trim(), 10);
        if (!Number.isNaN(parsed)) retryOwnerPid = parsed;
      } catch { /* ignore */ }
      throw new DaemonAlreadyRunningError(lockPath, retryOwnerPid);
    }
  }
}
