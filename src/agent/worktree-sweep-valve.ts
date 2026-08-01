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
 * Contract: `readRootSweepCount` returns `null` only when `.afk-worktrees/`
 * is absent OR is not a directory (the write fails `ENOENT` / `ENOTDIR`) —
 * this root has nothing for the sweep to do at all, so the caller falls back
 * to the legacy machine-global telemetry count exactly as before. Any OTHER
 * write failure (the directory exists but the marker itself is unusable —
 * wrong-owner file, a directory sitting where the marker should be, a
 * permissions error) returns `0`, FORCING previews, rather than `null`.
 *
 * History: an earlier version of this contract returned
 * `null` for every unusable marker, reasoning that reporting 0 would pin such
 * a root in dry-run forever. That reasoning held only for the
 * directory-missing case. Once `.afk-worktrees/` exists, a `null` here falls
 * through to `countPriorSuccessfulRuns` — the machine-global count — which on
 * any long-lived machine is already ≥ `SOFT_LAUNCH_RUNS`, so a root whose
 * marker is unusable got a LIVE destructive sweep with zero previews ever
 * having run against it — silently, since worktree removal itself still
 * succeeds. Reaching that branch takes a marker that is BOTH unreadable and
 * unwritable (the read above returns early whenever the content parses), e.g.
 * a `.sweep-runs` created once under `sudo` and left mode 0600 owned by
 * another uid inside an otherwise fully-writable `.afk-worktrees/`, or a
 * directory sitting at the marker path (`EISDIR`). Forcing 0 instead trades
 * that silent destructive sweep for a root pinned in dry-run, and the pin is
 * NOT permanent: the REPL boot-prune path passes `bypassSoftLaunch: true` and
 * reaps regardless of marker state, and repairing the marker's permissions
 * restores the normal daemon path. `null` remains reserved for "no per-root
 * signal at all" — the cases where `.afk-worktrees/` is not a usable
 * directory, and the legacy fallback is the correct and only sane behaviour.
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
 * Sweeps previously recorded against `repoRoot`, or `null` only when
 * `.afk-worktrees/` is absent or is not a directory (see the module Contract).
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
    // Plain 'w': also repairs a corrupt marker by resetting it to 0.
    await fs.writeFile(target, '0', 'utf-8');
    return 0;
  } catch (err) {
    // ENOENT/ENOTDIR here mean `.afk-worktrees/` is absent, or is a plain
    // file rather than a directory — either way this root has nothing for the
    // sweep to do (the orphan scan's own readdir fails identically), so fall
    // back to the legacy machine-global count exactly as before. Any OTHER
    // errno means the directory exists but the marker itself is unusable
    // (wrong owner, permissions, a directory where the file should be) —
    // force previews rather than silently inheriting an already-exhausted
    // global count (see module Contract).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return 0;
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
