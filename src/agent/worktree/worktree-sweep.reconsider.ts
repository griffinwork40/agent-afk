/**
 * Sweep reconsideration: auto-unlock locked worktrees whose preservation reason
 * no longer applies.
 *
 * Contract: this module contains ALL the reconsideration logic so the main
 * sweep engine (worktree-sweep.ts) only needs a single import + call-site.
 * No removal happens here — the two-phase protocol is:
 *   1. This function auto-unlocks when the reason has expired (this tick).
 *   2. Normal sweep classification removes the now-unlocked tree next tick.
 *
 * Invariant: `kept-on-exit` and `ignored-local-state` reasons are NEVER
 * auto-unlocked — they represent explicit human intent or non-rebuildable
 * local state that cannot be verified remotely. Only `commits-ahead` (push
 * check) and `dirty` (status check) are auto-resolvable.
 *
 * @module agent/worktree-sweep.reconsider
 */

import type { ExecFileFn } from './worktree-sweep.js';

/** Subset of WorktreeMeta fields relevant to reconsideration. */
export interface ReconsiderMeta {
  preservedReason?: string;
  preservedAt?: string;
  commitsAheadAtPreserve?: number;
}

export interface ReconsiderArgs {
  execFile: ExecFileFn;
  repoRoot: string;
  worktreePath: string;
  meta?: ReconsiderMeta;
  /** Raw lock reason string from `git worktree list --porcelain` (after `locked `). */
  lockReason?: string;
}

export interface ReconsiderResult {
  unlocked: boolean;
  reason: string;
}

/**
 * Probe whether all commits on HEAD have been pushed to the upstream branch.
 *
 * Contract: runs `git log --oneline @{upstream}..HEAD` inside the worktree.
 * Empty output means every commit is reachable from the remote → safe to unlock.
 * Fails SAFE: any error (no upstream, detached HEAD, network) returns a non-empty
 * string so the caller treats the tree as still holding unpushed work.
 */
async function allCommitsPushed(execFile: ExecFileFn, worktreePath: string): Promise<boolean> {
  try {
    const r = await execFile('git', ['-C', worktreePath, 'log', '--oneline', '@{upstream}..HEAD']);
    return r.stdout.trim() === '';
  } catch {
    return false; // fail safe — keep locked when probe fails
  }
}

/**
 * Probe whether the working tree is clean (no uncommitted changes).
 *
 * Contract: runs `git status --porcelain` inside the worktree. Empty output
 * means no uncommitted changes → safe to unlock.
 * Fails SAFE: any error returns false (tree treated as still dirty).
 */
async function isTreeClean(execFile: ExecFileFn, worktreePath: string): Promise<boolean> {
  try {
    const r = await execFile('git', ['-C', worktreePath, 'status', '--porcelain']);
    return r.stdout.trim() === '';
  } catch {
    return false; // fail safe — keep locked when probe fails
  }
}

/**
 * Reconsider whether a locked worktree should be auto-unlocked.
 *
 * Fires for every locked candidate whose `lockReason` starts with
 * `afk: isolated-worktree preserved`. Guards NEVER auto-unlock:
 *   - `ignored-local-state` (non-rebuildable local state)
 *   - `kept-on-exit` or any reason not set by teardown (human intent)
 *   - Trees where the reconsideration probe itself fails
 *
 * Two probes are supported:
 *   - `commits-ahead`: re-runs `git log @{upstream}..HEAD`; unlocks when empty.
 *   - `dirty`: re-runs `git status --porcelain`; unlocks when empty.
 *
 * Returns `{ unlocked: true, reason }` when the tree was auto-unlocked,
 * `{ unlocked: false, reason }` otherwise. The caller records the reason
 * in the sweep warnings log.
 */
export async function reconsiderLockedWorktree(
  args: ReconsiderArgs,
): Promise<ReconsiderResult> {
  const { execFile, worktreePath, meta, lockReason } = args;

  // Only auto-reconsider trees locked by the teardown path.
  if (!lockReason?.startsWith('afk: isolated-worktree preserved')) {
    return { unlocked: false, reason: 'lock not set by teardown path' };
  }

  const preserved = meta?.preservedReason;

  // Ignored local state and unrecognised/absent reasons are never auto-unlocked.
  if (!preserved || preserved === 'ignored-local-state') {
    return { unlocked: false, reason: `preserved reason not auto-resolvable: ${preserved ?? 'unknown'}` };
  }

  if (preserved === 'commits-ahead') {
    const pushed = await allCommitsPushed(execFile, worktreePath);
    if (!pushed) return { unlocked: false, reason: 'commits still unpushed' };
    try {
      await execFile('git', ['-C', args.repoRoot, 'worktree', 'unlock', worktreePath]);
      return { unlocked: true, reason: 'commits-ahead: all commits now pushed' };
    } catch (err) {
      return { unlocked: false, reason: `unlock failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (preserved === 'dirty') {
    const clean = await isTreeClean(execFile, worktreePath);
    if (!clean) return { unlocked: false, reason: 'working tree still dirty' };
    try {
      await execFile('git', ['-C', args.repoRoot, 'worktree', 'unlock', worktreePath]);
      return { unlocked: true, reason: 'dirty: working tree is now clean' };
    } catch (err) {
      return { unlocked: false, reason: `unlock failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { unlocked: false, reason: `unrecognised preserved reason: ${preserved}` };
}
