/**
 * Verdict-action dispatch for the worktree sweep engine.
 *
 * Each exported helper takes only explicit parameters (no closures over
 * runSweep locals) and is unit-testable in isolation.
 *
 * @module agent/worktree-sweep.actions
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../../utils/errors.js';
import { shortBranchName } from './worktree-sweep.classify.js';
import { classifyOrphanDir } from './worktree-orphan-guard.js';
import { reconsiderLockedWorktree } from './worktree-sweep.reconsider.js';
import { probeNonRebuildableIgnoredFiles } from './worktree-ignored-probe.js';
import {
  type WorktreeMeta,
  type WorktreeCandidate,
  type WorktreeVerdict,
  type DirtyReason,
  MAX_TRUSTED_PID_AGE_MS,
  MIN_EMPTY_AGE_MS,
  isProcessAlive,
  isPathWithin,
} from './worktree-sweep.classify.js';
import type { ExecFileFn, SweepResult } from './worktree-sweep.js';

// ---------------------------------------------------------------------------
// Orphan-directory sweep
// ---------------------------------------------------------------------------

/**
 * Invariant: the orphan path has no git information — the directory is
 * absent from `git worktree list`, so `git status` cannot classify it
 * and none of the registered-candidate protections apply. The guard is
 * the substitute floor and it runs in dry-run too, so `list` reports the
 * preservation instead of implying the next tick will delete (#794).
 */
export async function sweepOrphanDirs(
  orphanedDirs: string[],
  effectiveDryRun: boolean,
  result: SweepResult,
): Promise<void> {
  for (const orphanPath of orphanedDirs) {
    let orphanAgeMs = 0;
    try {
      const stat = await fs.stat(orphanPath);
      // Some filesystems report a zero/invalid birth time when creation
      // time is unavailable. Treat that as unknown (age 0), not as an
      // epoch-old directory eligible for immediate removal.
      if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
        orphanAgeMs = Math.max(0, Date.now() - stat.birthtimeMs);
      }
    } catch { /* use 0 */ }

    const guard = await classifyOrphanDir(orphanPath, orphanAgeMs, MIN_EMPTY_AGE_MS);
    result.candidates.push({
      path: orphanPath,
      verdict: guard.remove ? 'orphaned-dir' : 'orphaned-dir-preserved',
      owner: 'interactive',
      ageMs: orphanAgeMs,
    });
    if (!guard.remove) {
      result.warnings.push(
        `[WARN] orphaned dir preserved (${guard.because}` +
          `${guard.detail === undefined ? '' : `: ${guard.detail}`}): ${orphanPath}`,
      );
      continue;
    }
    if (!effectiveDryRun) {
      try {
        await fs.rm(orphanPath, { recursive: true, force: true });
        result.removed.push(orphanPath);
      } catch (err) {
        result.warnings.push(
          `[ERROR] Failed to remove orphaned dir ${orphanPath}: ${errorMessage(err)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-candidate probe: dirty status, commits-ahead, liveness
// ---------------------------------------------------------------------------

export interface CandidateProbeResult {
  isDirty: boolean;
  dirtyReason: DirtyReason;
  commitsAhead: number;
  commitsUnpushed: number;
  ownerLiveness: WorktreeCandidate['ownerLiveness'];
}

/**
 * Probes a registered worktree for dirty status, commits ahead of base,
 * and owner-process liveness. All git calls are best-effort; failures fall
 * safe (dirty / preserve).
 */
export async function probeCandidate(
  execFile: ExecFileFn,
  repoRoot: string,
  entryPath: string,
  entryHead: string | undefined,
  mainHead: string | undefined,
  meta: WorktreeMeta | undefined,
  ageMs: number,
  liveSessionCwds: string[],
  warnings: string[],
): Promise<CandidateProbeResult> {
  // --- dirty status ---
  let isDirty = false;
  let dirtyReason: DirtyReason = 'clean';
  try {
    const statusResult = await execFile('git', ['--no-optional-locks', '-C', entryPath, 'status', '--porcelain']);
    isDirty = statusResult.stdout.trim().length > 0;
    if (isDirty) dirtyReason = 'uncommitted changes';
  } catch {
    isDirty = true; /* treat as dirty — safe fallback */
    dirtyReason = 'git status failed';
  }

  // Invariant: bare `--porcelain` reports untracked files but NEVER ignored
  // ones, so a tree holding only ignored content reads clean here and every
  // removal path below runs `remove --force`, deleting it. Committed work
  // survives (branch refs live in the shared .git), but a worktree-local
  // `.env` or scratch file does not (#759). Probe for ignored content a
  // rebuild could NOT restore and treat it as dirty. Rebuildable output
  // (node_modules/, dist/, caches) is deliberately NOT protective — that
  // would make every worktree immortal and defeat the sweep.
  if (!isDirty) {
    const probe = await probeNonRebuildableIgnoredFiles(execFile, entryPath);
    isDirty = probe.protect;
    if (probe.protect) {
      dirtyReason =
        probe.because === 'git-failed'
          ? 'ignored-file probe failed'
          : `non-rebuildable ignored files: ${probe.detail}`;
    }
    // A protect-on-failure is indistinguishable from a real find at the
    // verdict level, so surface it: otherwise a worktree that git can no
    // longer read stays preserved forever with no trace of why.
    if (probe.protect && probe.because === 'git-failed') {
      warnings.push(
        `[WARN] ignored-file probe failed for ${entryPath} — preserving (${probe.detail})`,
      );
    }
  }

  // --- commits ahead ---
  let commitsAhead = 0;
  if (!isDirty && entryHead) {
    // Contract: `commitsAhead > 0` marks a worktree as holding unmerged
    // committed work, which the classifier preserves (`stale-clean`) and
    // never reaps. Getting this count right is load-bearing for not
    // destroying work.
    //
    // Invariant: when meta has NO `baseSha`, we must NOT fall back to
    // `entryHead` as the base. `rev-list HEAD..HEAD` is always 0, so a
    // baseSha-less worktree that actually holds commits would look empty
    // and be force-removed by the `empty`/`dead-owner` verdicts. Meta is
    // absent/minimal exactly for hand-created `git worktree add` trees
    // adopted by touchWorktreeOccupancy (which writes `{owner:'agent'}`
    // with no baseSha). Fall back to the main worktree's HEAD and count
    // commits reachable from this tree but not from main — the true
    // "unmerged work" signal.
    try {
      const revListArgs =
        meta?.baseSha !== undefined
          ? ['-C', repoRoot, 'rev-list', `${meta.baseSha}..${entryHead}`, '--count']
          : mainHead !== undefined && mainHead !== entryHead
            ? ['-C', repoRoot, 'rev-list', entryHead, '--not', mainHead, '--count']
            : undefined;
      // `revListArgs === undefined` means no recorded base AND the tree
      // sits at the main worktree's commit (or main HEAD is unknown) —
      // genuinely nothing ahead, so leave commitsAhead at 0.
      if (revListArgs !== undefined) {
        const countResult = await execFile('git', revListArgs);
        commitsAhead = parseInt(countResult.stdout.trim(), 10) || 0;
      }
    } catch { commitsAhead = 0; }
  }

  // --- commits unpushed ---
  // Invariant: commitsUnpushed starts EQUAL to commitsAhead (fully
  // unpushed) and is only ever lowered by a successful upstream read.
  // Every failure path — no upstream configured, detached HEAD, unreadable
  // remote-tracking ref, git error — leaves it at commitsAhead, so the
  // classifier preserves the tree exactly as it did before this field
  // existed. Never initialise this to 0.
  let commitsUnpushed = commitsAhead;
  if (commitsAhead > 0) {
    try {
      // @{upstream} resolves the branch's configured remote-tracking ref.
      // rev-list @{upstream}..HEAD counts commits present here but not on
      // the remote; 0 means the push landed and the remote holds the work.
      const unpushedResult = await execFile('git', [
        '-C', entryPath, 'rev-list', '@{upstream}..HEAD', '--count',
      ]);
      const parsed = parseInt(unpushedResult.stdout.trim(), 10);
      if (Number.isInteger(parsed) && parsed >= 0) commitsUnpushed = parsed;
    } catch { /* no upstream / unreadable → stay at commitsAhead */ }
  }

  // --- owner liveness ---
  // Constraint: ownerLiveness must only be 'dead'/'alive' when the meta
  // is fresh enough that PID reuse is implausible. Outside the trust
  // window we fall through to 'unknown' and the classifier ignores PID,
  // using the existing age-gated path instead.
  let ownerLiveness: WorktreeCandidate['ownerLiveness'] = 'unknown';
  if (
    typeof meta?.pid === 'number' &&
    Number.isInteger(meta.pid) &&
    meta.pid > 0 &&
    ageMs <= MAX_TRUSTED_PID_AGE_MS
  ) {
    ownerLiveness = isProcessAlive(meta.pid) ? 'alive' : 'dead';
  }

  // A live session working inside this worktree overrides a dead creator
  // pid — never reap an actively-used worktree.
  if (
    ownerLiveness !== 'alive' &&
    liveSessionCwds.some((cwd) => isPathWithin(cwd, entryPath))
  ) {
    ownerLiveness = 'alive';
  }

  return { isDirty, dirtyReason, commitsAhead, commitsUnpushed, ownerLiveness };
}

// ---------------------------------------------------------------------------
// Verdict-action dispatch
// ---------------------------------------------------------------------------

/**
 * Applies the action dictated by `verdict` for a single registered worktree.
 *
 * Invariant: branch ref may be deleted ONLY when commitsAhead === 0 (all
 * work is on the remote). `git branch -d` deletes a branch merged to its
 * upstream, which is exactly the pushed-worktree state.
 *
 * Verdict precedence order is enforced by the classifier
 * (worktree-sweep.classify.ts); this function only dispatches the action.
 */
export async function applyVerdictAction(
  verdict: WorktreeVerdict,
  execFile: ExecFileFn,
  repoRoot: string,
  entryPath: string,
  entryBranch: string | undefined,
  entryLockReason: string | undefined,
  candidate: WorktreeCandidate,
  meta: WorktreeMeta | undefined,
  result: SweepResult,
): Promise<void> {
  // Invariant: the branch ref is the last copy of committed work once the
  // checkout is gone, so it may be deleted ONLY when the tree held nothing
  // ahead of base. `git branch -d` deletes a branch that is merged to its
  // UPSTREAM (git prints "merged to refs/remotes/origin/X, but not yet
  // merged to HEAD" and exits 0) — precisely the state a pushed worktree is
  // in. Gating on commitsAhead keeps a reaped-but-pushed tree recoverable
  // from the local branch even if its remote branch was later deleted and
  // the tracking ref pruned, which is otherwise unrecoverable-by-gc.
  const branchSafeToDelete = candidate.commitsAhead === 0;

  const reapClean = async (): Promise<void> => {
    await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', entryPath]);
    if (entryBranch && branchSafeToDelete) {
      await execFile('git', ['-C', repoRoot, 'branch', '-d', shortBranchName(entryBranch)]).catch(() => {});
    } else if (entryBranch) {
      result.warnings.push(`[INFO] reaped worktree with pushed commits; branch preserved (${shortBranchName(entryBranch)}): ${entryPath}`);
    }
    result.removed.push(entryPath);
  };

  if (verdict === 'empty' || verdict === 'dead-owner') {
    await reapClean();
  } else if (verdict === 'stale-clean') {
    // Invariant: `stale-clean` fires only on trees with commits ahead
    // of base — a clean tree with zero commits ahead is always caught
    // by `empty` first. Removing here therefore destroys exclusively
    // trees holding committed-but-unmerged work (the branch ref
    // survives, the checkout does not). Preserve + warn instead,
    // mirroring `stale-dirty`; explicit removal paths (`afk worktree
    // prune`-adjacent tooling, the model-facing `worktree` tool) are
    // the sanctioned way to drop these.
    result.warnings.push(
      `[WARN] stale-clean worktree preserved (commits ahead of base): ${entryPath}`,
    );
  } else if (verdict === 'stale-dirty') {
    result.warnings.push(
      `[WARN] stale-dirty worktree preserved (${candidate.dirtyReason}): ${entryPath}`,
    );
  } else if (verdict === 'locked') {
    // Two-phase: auto-unlock when the preservation reason has expired;
    // normal classification removes the tree on the NEXT sweep tick.
    const r = await reconsiderLockedWorktree({ execFile, repoRoot, worktreePath: entryPath, meta, lockReason: entryLockReason });
    if (r.unlocked) result.warnings.push(`[INFO] auto-unlocked preserved worktree (${r.reason}): ${entryPath}`);
  }
  // 'active' → no-op
}

// ---------------------------------------------------------------------------
// Age resolution helper
// ---------------------------------------------------------------------------

export async function resolveWorktreeAgeMs(
  entryPath: string,
  meta: WorktreeMeta | undefined,
): Promise<number> {
  const createdAt = meta?.createdAt;
  if (createdAt) {
    return Date.now() - new Date(createdAt).getTime();
  }
  try {
    const stat = await fs.stat(entryPath);
    return Date.now() - stat.birthtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Orphan-dir collection helper (symlink-safe)
// ---------------------------------------------------------------------------

/**
 * Scans .afk-worktrees/ for directories not in the registered-paths set.
 * Invariant: the orphan scan is the one path that recursively DELETES a
 * directory chosen by disk listing rather than by git, so its root must be
 * a real directory in this repo. Skip it if .afk-worktrees is a symlink.
 */
export async function collectOrphanDirs(
  afkWorktreesRoot: string,
  registeredPaths: Set<string>,
  warnings: string[],
): Promise<string[]> {
  try {
    if ((await fs.lstat(afkWorktreesRoot)).isSymbolicLink()) {
      warnings.push(
        `[WARN] skipping orphan scan: .afk-worktrees is a symlink, not a directory: ${afkWorktreesRoot}`,
      );
      return [];
    }
  } catch { /* absent — handled by the readdir below */ }

  try {
    const entries = await fs.readdir(afkWorktreesRoot, { withFileTypes: true });
    const diskEntries = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(afkWorktreesRoot, e.name));
    return diskEntries.filter((d) => !registeredPaths.has(d));
  } catch {
    return []; /* .afk-worktrees doesn't exist yet — no orphaned dirs */
  }
}
