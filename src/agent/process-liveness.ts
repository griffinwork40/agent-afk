/**
 * Process liveness probing.
 *
 * `kill(pid, 0)` sends no signal — it only performs the permission and
 * existence checks the kernel would do for a real signal. That makes it the
 * cheapest portable way to ask "is this pid still running?".
 *
 * Why this module exists: several on-disk registries record a `pid` and later
 * need to know whether the owning process is still alive — presence files, the
 * worktree sweep's owner check, stale-lock detection. Without a liveness probe,
 * a record left behind by a process that died without running its cleanup
 * handlers (SIGKILL, OOM kill, power loss) looks live forever.
 *
 * NOTE: `src/agent/worktree/worktree-sweep.classify.ts` previously carried its
 * own private copy of this idiom. That copy has been removed and replaced with
 * a re-export from this module (`export { isProcessAlive } from
 * '../../process-liveness.js'`). Consolidation is complete.
 *
 * @module agent/process-liveness
 */

import { isErrnoCode } from '../utils/errors.js';

/** Liveness verdict for a recorded pid. */
export type ProcessLiveness =
  /** The pid is running (or exists but belongs to another user). */
  | 'alive'
  /** The pid is not running — the owning process is gone. */
  | 'dead'
  /** No usable pid was recorded, so liveness cannot be determined. */
  | 'unknown';

/**
 * Whether `pid` currently exists.
 *
 * `EPERM` (permission denied) means the process exists but is not ours, which
 * counts as alive. Any other error — notably `ESRCH` (no such process) — means
 * it is gone.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoCode(err, 'EPERM')) return true;
    return false;
  }
}

/**
 * Classify a pid value that came off disk, where it may be absent, the wrong
 * type, or nonsense.
 *
 * Returns `'unknown'` rather than `'dead'` for an unusable pid. That asymmetry
 * is deliberate and load-bearing: consumers filter on `'dead'`, so an
 * unparseable record must never be mistaken for a finished one.
 *
 * Caveat: pids are recycled by the OS. A record whose owner died can read
 * `'alive'` again if an unrelated process later inherits that pid. Pair this
 * with a freshness check (e.g. a heartbeat timestamp) when that matters.
 */
export function classifyPidLiveness(pid: unknown): ProcessLiveness {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return 'unknown';
  }
  return isProcessAlive(pid) ? 'alive' : 'dead';
}
