/**
 * Reaper for presence files left behind by sessions that died without running
 * their exit handlers (SIGKILL, OOM kill, power loss). Before this, presence
 * files were only removed on graceful exit and accumulated indefinitely.
 *
 * Invariant: a file is deleted ONLY when `kill(pid, 0)` fails with `ESRCH`
 * ("no such process"), which is proof the recorded owner is gone. It is never
 * deleted on a start-time mismatch (the probe can be wrong, and a hidden record
 * is recoverable while a deleted one is not), on `EPERM` (process exists, owned
 * by someone else), on an unusable pid, or for one of this process's own
 * session ids. The worktree sweep reads raw presence to protect running
 * sessions' worktrees, so an over-eager delete here could cost a user their
 * worktree; ESRCH-only keeps this reaper strictly safer than that guard.
 *
 * @module agent/awareness/presence.reaper
 */

import { unlink } from 'fs/promises';
import { readPresenceFiles } from './presence.js';

/** Injection seams for {@link sweepDeadPresence}. */
export interface SweepDeadPresenceOptions {
  /** Session ids owned by the calling process — never deleted. */
  selfIds?: ReadonlySet<string>;
  /** `process.kill` seam for tests. */
  kill?: (pid: number, signal: 0) => void;
  /** `unlink` seam for tests. */
  remove?: (path: string) => Promise<void>;
}

/** True only when probing `pid` throws ESRCH. */
function provenGone(pid: unknown, kill: (pid: number, signal: 0) => void): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Delete presence files whose owning pid is proven gone. Returns the number of
 * files removed. Best-effort and never throws.
 */
export async function sweepDeadPresence(opts: SweepDeadPresenceOptions = {}): Promise<number> {
  const selfIds = opts.selfIds ?? new Set<string>();
  const kill = opts.kill ?? ((pid: number, signal: 0) => void process.kill(pid, signal));
  const remove = opts.remove ?? ((p: string) => unlink(p));
  let removed = 0;
  try {
    for (const record of await readPresenceFiles()) {
      if (selfIds.has(record.sessionId)) continue;
      if (record.pid === process.pid) continue;
      if (!provenGone(record.pid, kill)) continue;
      try {
        await remove(record.path);
        removed += 1;
      } catch {
        // Already gone or unremovable — skip.
      }
    }
  } catch {
    // Best-effort.
  }
  return removed;
}
