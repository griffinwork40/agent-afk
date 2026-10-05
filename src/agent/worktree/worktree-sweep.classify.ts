/**
 * Internal types, utilities, porcelain parser, and verdict classifier for
 * the worktree sweep engine.
 *
 * Extracted from `worktree-sweep.ts` to keep that file within the 350-code-
 * line ceiling. All types and functions here are consumed exclusively by
 * `worktree-sweep.ts`; the public API surface is unchanged.
 *
 * @module agent/worktree/worktree-sweep.classify
 */

import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

// Invariant: this constant is defined here (not in worktree-sweep.ts) to avoid
// a circular import (worktree-sweep.ts imports from this module). The original
// public export in worktree-sweep.ts re-exports it from here.
export const MIN_EMPTY_AGE_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Why a candidate reads dirty. Carried so a preservation warning can name the
 * actual cause: an ignored-state protect is NOT "uncommitted changes" — git
 * status calls that tree clean — and reporting it as such sends the reader
 * looking for a diff that does not exist.
 */
export type DirtyReason =
  | 'clean'
  | 'uncommitted changes'
  | 'git status failed'
  // Carries the offending path. Naming it is the difference between a warning
  // the reader can act on and one that sends them hunting for a secret that
  // is not there: the entry holding a tree is as often leftover test detritus
  // as it is a real `.env`.
  | `non-rebuildable ignored files: ${string}`
  | 'ignored-file probe failed';

export interface WorktreeMeta {
  owner: 'interactive' | 'diagnose' | string;
  /**
   * PID of the process that created this worktree. Used by the sweep
   * engine to accelerate reaping of dead-owner ghost worktrees regardless
   * of age. Optional — worktrees created before this field was added will
   * lack it and fall through to the existing age-gated verdict path.
   *
   * PID reuse is bounded by {@link createdAt}: callers must not trust the
   * `pid` field once the meta is older than {@link MAX_TRUSTED_PID_AGE_MS},
   * because the kernel's PID space may have wrapped.
   */
  pid?: number;
  createdAt: string;
  baseSha?: string;
  baseBranch?: string;
  /** Why the tree was preserved at teardown. Only set by teardown paths. */
  preservedReason?: 'dirty' | 'commits-ahead' | 'ignored-local-state';
  /** ISO timestamp when the tree was preserved. */
  preservedAt?: string;
  /** Number of commits ahead of base at preservation time. */
  commitsAheadAtPreserve?: number;
}

export interface WorktreeCandidate {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
  meta?: WorktreeMeta;
  ageMs: number;
  isDirty: boolean;
  /** Populated whenever `isDirty` is true; `'clean'` otherwise. */
  dirtyReason: DirtyReason;
  commitsAhead: number;
  /**
   * Commits on this worktree's HEAD that exist NOWHERE but this checkout —
   * i.e. `@{upstream}..HEAD`. Zero means every local commit has been pushed,
   * so the remote holds the work and the checkout is disposable.
   *
   * Invariant: this is the only field that may relax a `commitsAhead > 0`
   * preservation gate, and it fails SAFE — no upstream configured, an
   * unreadable ref, or any git error yields `commitsUnpushed === commitsAhead`
   * (treat as unreplaceable). It is never derived from `commitsAhead === 0`.
   */
  commitsUnpushed: number;
  /**
   * Tri-state liveness of the owning process recorded in `meta.pid`:
   *   - `'alive'`      — `meta.pid` resolves to a live process.
   *   - `'dead'`       — `meta.pid` is present, the meta is within the
   *                       PID-reuse safety window, and the kernel has no
   *                       process at that pid. Eligible for accelerated
   *                       reaping when the tree is clean.
   *   - `'unknown'`    — no `meta.pid` field, or meta is older than the
   *                       PID-reuse safety window. Caller must fall through
   *                       to the age-gated verdict path.
   */
  ownerLiveness: 'alive' | 'dead' | 'unknown';
}

export type WorktreeVerdict =
  | 'empty'
  | 'stale-clean'
  | 'stale-dirty'
  | 'locked'
  | 'active'
  | 'orphaned-dir'
  /** An unregistered directory that the orphan guard could not prove safe to remove. */
  | 'orphaned-dir-preserved'
  | 'orphaned-registration'
  /**
   * The owning process recorded in `.afk-worktree-meta.json` is gone, the
   * meta is within the PID-reuse safety window, and the worktree has no
   * uncommitted changes and no commits ahead of base. Eligible for removal
   * regardless of age — these are the ghost worktrees left behind when a
   * REPL crashed or was killed. Never assigned when the tree is dirty or
   * has unpushed commits.
   */
  | 'dead-owner';

/**
 * Maximum age of a `.afk-worktree-meta.json` whose `pid` field we still
 * trust for liveness checks. Beyond this window we conservatively treat
 * the recorded PID as unknown — the kernel may have wrapped the PID space
 * and any liveness probe could now be referring to an unrelated process.
 *
 * 30 days is well beyond typical Linux PID-wrap intervals on a busy system
 * (default `pid_max` 32768 wraps in hours; tuned-up systems wrap in days).
 * macOS PIDs reuse much faster but still safely fit inside this window for
 * the dead-owner verdict's purpose (accelerated reaping of *recent*
 * ghosts — anything older than 30 days is already eligible for the
 * existing stale-clean / stale-dirty verdicts).
 */
export const MAX_TRUSTED_PID_AGE_MS = 30 * 86_400_000;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

// isProcessAlive was previously defined here; now re-exported from the
// canonical process-liveness module so worktree-sweep.ts imports continue
// to work without any change to their import path.
export { isProcessAlive } from '../process-liveness.js';

// Invariant: this realpathSafe is intentionally distinct from the one in
// _cwd-utils.ts. The _cwd-utils version resolves the nearest existing ancestor
// for not-yet-created write targets; this version only resolves paths that
// already exist (falling back to the raw path). Do not consolidate.
export function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * True when `child` is the same path as, or nested inside, `parent`. Both are
 * realpath-normalized first. Used to decide whether a live session's cwd sits
 * inside a candidate worktree.
 */
export function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(realpathSafe(parent), realpathSafe(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `git worktree list --porcelain` reports `branch` as a fully-qualified ref
 * (e.g. `refs/heads/afk/foo`), but `git branch -d` expects the short branch
 * name (`afk/foo`) — passing the qualified ref makes the delete always fail
 * with "branch 'refs/heads/afk/foo' not found" (#371). Strip the prefix
 * before every `git branch -d` invocation.
 */
export function shortBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

// ---------------------------------------------------------------------------
// Porcelain parser
// ---------------------------------------------------------------------------

export interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
  locked: boolean;
  /** Reason string from `git worktree list --porcelain` (the part after `locked `). */
  lockReason?: string;
  prunable: boolean;
  isBare: boolean;
}

export function parseWorktreeList(stdout: string): ParsedWorktree[] {
  const blocks = stdout.trim().split(/\n\n+/);
  const result: ParsedWorktree[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let path = '';
    let head = '';
    let branch = '';
    let locked = false;
    let lockReason: string | undefined;
    let prunable = false;
    let isBare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
      else if (line.trim().startsWith('locked')) { locked = true; lockReason = line.trim().slice('locked'.length).trim() || undefined; }
      else if (line.trim() === 'prunable') prunable = true;
      else if (line.trim() === 'bare') isBare = true;
    }
    if (path) result.push({ path, head, branch, locked, lockReason, prunable, isBare });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Verdict classifier
// ---------------------------------------------------------------------------

/**
 * True when this checkout is the ONLY place its committed work exists.
 *
 * Invariant: `git worktree remove` never deletes the branch ref, so committed
 * work is destroyed only if it is unreachable from anywhere else. A branch
 * whose commits are all pushed (`commitsUnpushed === 0`) has them on the
 * remote, so reaping the checkout costs a directory, not history — which is
 * why a PR-shipped worktree stops being sacred the moment the push lands.
 * Unpushed commits stay protected exactly as before.
 */
function holdsUnreplaceableCommits(candidate: WorktreeCandidate): boolean {
  return candidate.commitsAhead > 0 && candidate.commitsUnpushed > 0;
}

export function classifyCandidate(
  candidate: WorktreeCandidate,
  maxAgeDaysClean: number,
  maxAgeDaysDirty: number,
): WorktreeVerdict {
  if (candidate.locked) return 'locked';

  const msPerDay = 86_400_000;
  const cleanThresholdMs = maxAgeDaysClean * msPerDay;
  const dirtyThresholdMs = maxAgeDaysDirty * msPerDay;

  // Constraint: dead-owner is checked BEFORE empty / stale-clean so that
  // a recent ghost (REPL crashed 5 minutes ago, age < MIN_EMPTY_AGE_MS,
  // age < cleanThreshold) still gets reaped on this sweep. The check is
  // gated on a clean tree AND zero commits ahead — we never reap dead-owner
  // worktrees that have any work the user could conceivably want back.
  if (
    candidate.ownerLiveness === 'dead' &&
    !candidate.isDirty &&
    !holdsUnreplaceableCommits(candidate)
  ) {
    return 'dead-owner';
  }

  // No commits ahead, no dirty files, and old enough to not be a freshly-
  // created worktree mid-setup → empty. The age guard closes the race where
  // a worktree created seconds before the cron fires would be reaped on its
  // first tick before the user has a chance to do anything in it. Gated on
  // ownerLiveness !== 'alive' the same way dead-owner is (#380) — without
  // this, the live-session presence guard (which forces ownerLiveness to
  // 'alive' when a live session's cwd is inside the worktree) only ever
  // protected the dead-owner path, so a live session's clean, 0-commits-
  // ahead worktree older than MIN_EMPTY_AGE_MS still got reaped mid-session.
  if (
    candidate.ownerLiveness !== 'alive' &&
    !holdsUnreplaceableCommits(candidate) &&
    !candidate.isDirty &&
    candidate.ageMs >= MIN_EMPTY_AGE_MS
  ) {
    return 'empty';
  }

  // Has dirty working tree past dirty threshold
  if (candidate.isDirty && candidate.ageMs > dirtyThresholdMs) return 'stale-dirty';

  // Clean committed work past clean threshold. Clean zero-ahead worktrees are
  // handled by `empty` once old enough; before then they stay active.
  if (
    !candidate.isDirty &&
    candidate.commitsAhead > 0 &&
    candidate.ageMs > cleanThresholdMs
  ) {
    return 'stale-clean';
  }

  return 'active';
}
