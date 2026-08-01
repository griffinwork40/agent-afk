/**
 * Per-root soft-launch valve for the worktree sweep.
 *
 * Invariant: the valve's promise is "a root is PREVIEWED before it is swept
 * destructively". Its counter used to be machine-global — every line in the
 * telemetry file with `taskId === 'worktree-prune'`, regardless of which repo
 * that tick actually touched. With exactly one root that was equivalent to a
 * per-root count. Once the daemon fans out over every registered root (#761),
 * it stops being equivalent: a root registered today inherits an
 * already-exhausted counter from months of ticks against a DIFFERENT repo and
 * gets a live destructive sweep on first contact, never seeing the three
 * dry-run previews the valve exists to provide.
 *
 * The count therefore lives with the root it describes: a plain integer in
 * `<repoRoot>/.afk-worktrees/.sweep-runs`. That directory is already owned by
 * the sweep engine, and the orphan scan only ever considers DIRECTORY entries,
 * so a marker file there is inert.
 *
 * Contract: `readRootSweepCount` returns `null` — never 0 — when the marker
 * cannot be used (missing `.afk-worktrees/`, read-only checkout, permissions).
 * That distinction is load-bearing. Reporting 0 for an unusable marker would
 * pin such a root in dry-run FOREVER, so its worktrees would accumulate and
 * never be reclaimed, which is precisely the #761 leak this whole change set
 * exists to close. `null` means "no per-root signal", and the caller falls
 * back to the legacy machine-global telemetry count.
 *
 * @module agent/worktree-sweep-valve
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Previews a root must accumulate before the sweep may remove anything. */
export const SOFT_LAUNCH_RUNS = 3;

const MARKER_NAME = '.sweep-runs';

function markerPath(repoRoot: string): string {
  return join(repoRoot, '.afk-worktrees', MARKER_NAME);
}

/**
 * Sweeps previously recorded against `repoRoot`, or `null` when this root
 * carries no usable marker (see the module Contract — `null` is not 0).
 *
 * Deliberately does NOT create `.afk-worktrees/`: a repo without that
 * directory has no managed worktrees to reclaim, and materialising it would
 * litter every repo the daemon merely visits.
 */
export async function readRootSweepCount(repoRoot: string): Promise<number | null> {
  const target = markerPath(repoRoot);
  try {
    const parsed = Number.parseInt((await fs.readFile(target, 'utf-8')).trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    /* absent or unreadable → fall through and try to initialise */
  }
  try {
    // Plain 'w': also repairs a corrupt marker by resetting it to 0. Fails
    // with ENOENT when .afk-worktrees/ does not exist, which is the signal
    // that this root has nothing for the sweep to do.
    await fs.writeFile(target, '0', 'utf-8');
    return 0;
  } catch {
    return null;
  }
}

/**
 * Record that `repoRoot` was swept. Best-effort: a failure here can only cost
 * an extra dry-run preview, never a destructive sweep.
 */
export async function recordRootSweep(repoRoot: string): Promise<void> {
  try {
    const current = await readRootSweepCount(repoRoot);
    if (current === null) return;
    await fs.writeFile(markerPath(repoRoot), String(current + 1), 'utf-8');
  } catch {
    /* best-effort */
  }
}
