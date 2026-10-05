/**
 * Live-session liveness for the worktree sweep engine.
 *
 * Invariant: a worktree hosting a LIVE top-level session must never be reaped,
 * even when the creator pid in .afk-worktree-meta.json is dead. The creating
 * process and the session actively working inside are frequently different
 * (a resumed session, or a hand-recreated worktree), so meta.pid alone would
 * let the dead-owner verdict reap an in-use worktree. Presence files are the
 * authoritative "someone is working here now" signal: each live top-level
 * session writes one with its own pid + cwd. A record is trusted only when its
 * pid is actually alive, so a crashed session's stale file cannot protect a
 * worktree forever.
 *
 * @module agent/worktree/worktree-sweep.liveness
 */

import { readPresenceFiles, type PresenceRecord } from '../awareness/presence.js';
import { isProcessAlive } from './worktree-sweep.classify.js';

/**
 * Return the cwds of all live top-level sessions. Presence is advisory and
 * best-effort: on any read failure this returns an empty list, so the sweep
 * falls back to the meta.pid liveness check alone (prior behavior).
 */
export async function readLiveSessionCwds(
  reader: () => Promise<PresenceRecord[]> = readPresenceFiles,
): Promise<string[]> {
  try {
    const records = await reader();
    return records
      .filter((r) => typeof r.pid === 'number' && r.pid > 0 && isProcessAlive(r.pid))
      .map((r) => r.cwd)
      .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0);
  } catch {
    return [];
  }
}
