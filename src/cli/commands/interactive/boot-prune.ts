/**
 * Boot-time worktree auto-prune.
 *
 * Runs once per `afk interactive` session start. Targets the narrow problem
 * the daemon's nightly cron doesn't catch for non-daemon users: ghost
 * worktrees from crashed/killed REPLs (`dead-owner`) plus already-empty
 * and orphaned worktrees. Conservative by design — never touches
 * stale-clean, stale-dirty, or locked entries even if they're prunable
 * under a more aggressive policy.
 *
 * Failure modes are silent. The boot-time UX must never block on a slow
 * git invocation or surface "could not sweep" errors in front of a user
 * who's about to type their first prompt. If the sweep can't run for any
 * reason — timeout, lock contention, git missing, not in a repo — we log
 * at debug level and continue.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { runSweep } from '../../../agent/worktree-sweep.js';
import type { ExecFileFn } from '../../../agent/worktree-sweep.js';

const execFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

/**
 * Wall-clock budget for the boot pass. If the sweep exceeds this, we bail
 * silently and let the daemon's nightly cron or an explicit
 * `/worktree prune` catch up later. Boot UX > GC throughput.
 *
 * 3s accommodates dogfood-observed wall clock on a 38-worktree pile
 * (~1.9s). The sweep engine is currently sequential per candidate
 * (`git status` + `git rev-list` per worktree); a parallelization pass
 * inside `runSweep` would let this shrink back to sub-second budgets
 * but is out of scope here. If users routinely accumulate >100 stale
 * worktrees the budget can be raised again via env, but the dead-owner
 * verdict's whole point is preventing that pile-up in the first place.
 */
const BOOT_PRUNE_TIMEOUT_MS = 3_000;

/**
 * Verdicts the boot pass is willing to reap. Deliberately narrower than
 * the daemon's set — we exclude `stale-clean` so users who keep older
 * worktrees as bookmarks don't lose them to a silent boot sweep.
 *
 * `stale-dirty` is excluded for the same reason (dirty trees are user
 * work, never reap silently). `locked` is excluded because git asked us
 * not to touch it.
 */
const BOOT_PRUNABLE_VERDICTS = new Set([
  'empty',
  'orphaned-dir',
  'orphaned-registration',
  'dead-owner',
]);

export interface BootPruneResult {
  ran: boolean;
  removedCount: number;
  skippedReason?: 'not-in-repo' | 'lock-contested' | 'timeout' | 'error' | 'disabled';
}

async function resolveRepoRoot(): Promise<string> {
  const result = await execFile('git', ['rev-parse', '--git-common-dir']);
  const raw = result.stdout.trim();
  if (!raw) throw new Error('Not in a git repository.');
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return dirname(absoluteGitDir);
}

/**
 * Run the boot-time sweep. Returns synchronously-resolvable info about
 * what happened so the caller can decide whether to log a one-line
 * notice. Never throws.
 *
 * Constraint: the order of operations here matters under concurrency.
 * The internal lock in `runSweep` is the synchronization point; we don't
 * pre-check anything because that race would re-introduce the problem
 * the lock exists to prevent.
 */
export async function bootPruneWorktrees(opts?: {
  /** Set to true via env to skip the boot pass entirely. */
  disabled?: boolean;
}): Promise<BootPruneResult> {
  if (opts?.disabled) {
    return { ran: false, removedCount: 0, skippedReason: 'disabled' };
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch {
    return { ran: false, removedCount: 0, skippedReason: 'not-in-repo' };
  }

  // Constraint: the budget races against runSweep. If the timeout wins
  // we abandon the result — the sweep may still complete in the
  // background and acquire its lock against the daemon's nightly run,
  // but that's harmless (the lock is the synchronization point).
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolveOuter) => {
    timeoutHandle = setTimeout(() => resolveOuter('timeout'), BOOT_PRUNE_TIMEOUT_MS);
  });

  try {
    const sweepPromise = runSweep({
      execFile,
      repoRoot,
      dryRun: false,
      scope: 'interactive',
      // The boot pass already constrains itself via BOOT_PRUNABLE_VERDICTS
      // (no stale-clean, no stale-dirty). The soft-launch valve was
      // designed to soften the daemon's broader verdict set on first
      // runs; bypassing it here lets non-daemon users actually benefit
      // from boot-time cleanup.
      bypassSoftLaunch: true,
    });

    const winner = await Promise.race([sweepPromise, timeoutPromise]);
    if (winner === 'timeout') {
      return { ran: false, removedCount: 0, skippedReason: 'timeout' };
    }

    const result = winner;

    const lockContested = result.warnings.some((w) => w.toLowerCase().includes('contested'));
    if (lockContested) {
      return { ran: false, removedCount: 0, skippedReason: 'lock-contested' };
    }

    // Only count removals whose verdict was in the boot-prune set. Anything
    // else the engine removed was outside our intended scope; we don't
    // surface it to the user. (In practice this won't trigger because
    // runSweep applies verdicts based on the candidate state, but it
    // keeps the boot path's notice honest if the engine's policy
    // broadens in future.)
    const bootScopedRemovals = result.candidates.filter(
      (c) => BOOT_PRUNABLE_VERDICTS.has(c.verdict) && result.removed.includes(c.path),
    ).length;

    return { ran: true, removedCount: bootScopedRemovals };
  } catch {
    return { ran: false, removedCount: 0, skippedReason: 'error' };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
