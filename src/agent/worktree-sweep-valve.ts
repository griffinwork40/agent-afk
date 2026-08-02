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
 * is absent OR is not a directory — this root has nothing for the sweep to do
 * at all, so the caller falls back to the legacy machine-global telemetry
 * count exactly as before. Once that directory exists, an unusable marker (a
 * symlink, a directory sitting where the marker should be, a wrong-owner or
 * unreadable file) returns `0`, FORCING previews, rather than `null`. A marker
 * that is absent returns `0` too: a fresh root previews before it reaps.
 * The read is pure — only `recordRootSweep` writes, and it opens the marker
 * with `O_NOFOLLOW` so a symlink there can never redirect the write.
 *
 * History: an earlier version of this contract returned
 * `null` for every unusable marker, reasoning that reporting 0 would pin such
 * a root in dry-run forever. That reasoning held only for the
 * directory-missing case. Once `.afk-worktrees/` exists, a `null` here falls
 * through to `countPriorSuccessfulRuns` — the machine-global count — which on
 * any long-lived machine is already ≥ `SOFT_LAUNCH_RUNS`, so a root whose
 * marker is unusable got a LIVE destructive sweep with zero previews ever
 * having run against it — silently, since worktree removal itself still
 * succeeds. Reaching that branch takes a marker that exists but is not a
 * readable regular file (the read returns early whenever the content parses),
 * e.g. a `.sweep-runs` created once under `sudo` and left mode 0600 owned by
 * another uid inside an otherwise fully-writable `.afk-worktrees/`, a
 * directory sitting at the marker path, or a symlink. Forcing 0 instead trades
 * that silent destructive sweep for a root pinned in dry-run, and the pin is
 * NOT permanent: the REPL boot-prune path passes `bypassSoftLaunch: true` and
 * reaps regardless of marker state, and repairing the marker's permissions
 * restores the normal daemon path. `null` remains reserved for "no per-root
 * signal at all" — the cases where `.afk-worktrees/` is not a usable
 * directory, and the legacy fallback is the correct and only sane behaviour.
 *
 * @module agent/worktree-sweep-valve
 */

import { promises as fs, type Stats } from 'node:fs';
import { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } from 'node:constants';
import { join } from 'node:path';

/** Previews a root must accumulate before the sweep may remove anything. */
export const SOFT_LAUNCH_RUNS = 3;

const MARKER_NAME = '.sweep-runs';
const MARKER_MODE = 0o600;

function markerPath(repoRoot: string): string {
  return join(repoRoot, '.afk-worktrees', MARKER_NAME);
}

function afkWorktreesDir(repoRoot: string): string {
  return join(repoRoot, '.afk-worktrees');
}

/**
 * Sweeps previously recorded against `repoRoot`, or `null` only when
 * `.afk-worktrees/` is absent or is not a directory (see the module Contract).
 *
 * Invariant: this read is PURE — it never creates, truncates, or repairs the
 * marker. It is reached from callers that are documented as read-only (`afk
 * worktree list`, `/worktree list`, every `dryRun: true` sweep), and the
 * previous probe-write meant those callers materialised `.sweep-runs` inside
 * the user's repo. Two consequences made that unacceptable rather than merely
 * untidy: a documented preview mutated the working tree, and the write was the
 * symlink-following one guarded below in `recordRootSweep`. Every outcome the
 * probe-write used to distinguish by errno is now derived from `stat`/`lstat`
 * instead, so the four-way contract is unchanged while the read stays inert.
 * `recordRootSweep` is the only writer.
 */
export async function readRootSweepCount(repoRoot: string): Promise<number | null> {
  // `.afk-worktrees/` absent, or present but not a directory → no per-root
  // signal exists at all; the caller takes the legacy machine-global count.
  try {
    if (!(await fs.stat(afkWorktreesDir(repoRoot))).isDirectory()) return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return 0; // directory unreadable → fail closed (force previews)
  }

  // `lstat`, not `stat`: a symlink at the marker path must be classified as
  // unusable on its own terms rather than resolved to whatever it points at.
  let markerStat: Stats;
  try {
    markerStat = await fs.lstat(markerPath(repoRoot));
  } catch {
    // ENOENT is the fresh-root case — previews start at 0 and the marker is
    // created later by recordRootSweep, not here. Any other errno means the
    // marker is unreadable. Both fail closed to previews, so neither needs to
    // be distinguished.
    return 0;
  }
  // A symlink, directory, socket, or device at the marker path is unusable:
  // force previews rather than inheriting an already-exhausted global count.
  if (!markerStat.isFile()) return 0;

  try {
    const parsed = Number.parseInt((await fs.readFile(markerPath(repoRoot), 'utf-8')).trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    /* unreadable (wrong owner, permissions) → fall through and fail closed */
  }
  return 0;
}

/**
 * Record that `repoRoot` was swept. Best-effort: a failure here can only cost
 * an extra dry-run preview, never a destructive sweep.
 */
export async function recordRootSweep(repoRoot: string): Promise<void> {
  try {
    const current = await readRootSweepCount(repoRoot);
    if (current === null) return;
    // SEC-4: open with O_NOFOLLOW to prevent symlink attacks. This is the only
    // write in the valve, and it targets a path inside a repo the daemon merely
    // visits — a checkout, restored backup, or copied tree can carry a symlink
    // at `.afk-worktrees/.sweep-runs`. A plain writeFile (O_TRUNC, follows
    // symlinks) would then truncate the LINK TARGET, i.e. an arbitrary file
    // OUTSIDE the repo, unattended on the daemon's cron tick. O_NOFOLLOW makes
    // that open fail with ELOOP instead; the catch below swallows it, so the
    // root simply keeps previewing — fail-closed, never destructive.
    // Mirrors src/cli/input/history.ts, which guards its own writes the same way.
    const handle = await fs.open(
      markerPath(repoRoot),
      O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
      MARKER_MODE,
    );
    try {
      await handle.writeFile(String(current + 1), 'utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    /* best-effort: a failure here costs an extra preview, never a destructive sweep */
  }
}
