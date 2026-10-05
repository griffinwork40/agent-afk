/**
 * Worktree cleanup logic for the `afk interactive` worktree subsystem.
 *
 * Extracted from worktree.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `runWorktreeCleanup`.
 *
 * This module contains the full cleanup procedure that was previously inlined
 * inside the `WorktreeHandle.cleanup` closure in `createWorktreeAt`. All
 * parameters are explicit — no closures over caller locals.
 */

import { env } from '../../../config/env.js';
import { probeNonRebuildableIgnoredFiles } from '../../../agent/worktree/worktree-ignored-probe.js';
import { recordCdIntent, shellWrapperActive } from '../../../utils/cd-on-exit.js';
import { detectShellFromEnv } from '../shell-init.js';
import type { ExecFileFn } from './worktree.js';
import type { WorktreeDisposition } from './worktree-disposition.js';

// ---------------------------------------------------------------------------
// Internal error type guard
// ---------------------------------------------------------------------------

interface ExecError extends Error {
  stderr?: string;
}

function isExecError(value: unknown): value is ExecError {
  return value instanceof Error;
}

// ---------------------------------------------------------------------------
// Cleanup parameters
// ---------------------------------------------------------------------------

export interface WorktreeCleanupParams {
  /** Absolute path to the worktree (stable for the life of the handle). */
  worktreePath: string;
  /** Branch name backing the worktree. */
  branch: string;
  /** Repo root used for `git -C <repoRoot>` invocations. */
  repoRoot: string;
  /** Injected execFile implementation (real or test double). */
  execFile: ExecFileFn;
  /** Force removal, skip dirty-state checks. True only on zero-turn sessions. */
  force?: boolean;
  /** Disposition directive from the caller (default: 'remove'). */
  disposition?: WorktreeDisposition;
}

// ---------------------------------------------------------------------------
// Core cleanup procedure
// ---------------------------------------------------------------------------

/**
 * Run the worktree cleanup procedure.
 *
 * Contract: best-effort — never throws. All git failures are caught and
 * surfaced via `console.warn` so shutdown paths cannot produce unhandled
 * promise rejections. The caller (WorktreeHandle.cleanup) wraps this in
 * a try/catch as an extra safety net, but that layer should never fire.
 */
export async function runWorktreeCleanup(params: WorktreeCleanupParams): Promise<void> {
  const { worktreePath: currentPath, branch: currentBranch, repoRoot, execFile } = params;

  if (params.force === true) {
    // Zero-turn session: no work was done, so skip the dirty-state check
    // AND the ignored-state probe below — nothing can have been written in
    // a session that took zero turns, so there is nothing to preserve.
    // and remove unconditionally.
    // eslint-disable-next-line no-console
    console.log(`Worktree removed (zero turns — no work done): ${currentPath}`);
    try {
      await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', currentPath]);
    } catch (err) {
      const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `Worktree cleanup: 'git worktree remove --force ${currentPath}' failed (${message}). Manual removal may be needed.`,
      );
      return;
    }
    try {
      await execFile('git', ['-C', repoRoot, 'branch', '-d', currentBranch]);
    } catch (err) {
      const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
      // eslint-disable-next-line no-console
      console.warn(`Could not delete branch '${currentBranch}': ${message}`);
    }
    return;
  }

  let status: { stdout: string; stderr: string };
  let ignoredProbeEarly: Awaited<ReturnType<typeof probeNonRebuildableIgnoredFiles>> | undefined;
  try {
    [status, ignoredProbeEarly] = await Promise.all([
      execFile('git', ['-C', currentPath, 'status', '--porcelain']),
      probeNonRebuildableIgnoredFiles(execFile, currentPath),
    ]);
  } catch (err) {
    const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `Worktree cleanup: could not check status at ${currentPath} (${message}). Skipping removal — manual cleanup may be needed.`,
    );
    return;
  }

  const preserveWorktree = (reason: string): void => {
    // eslint-disable-next-line no-console
    console.log(
      `Worktree preserved at ${currentPath} (branch: ${currentBranch}) — ${reason}.`,
    );
    // Record the worktree as the parent shell's desired cwd. The
    // optional `afk` shell wrapper (installed via `afk shell-init`)
    // reads this marker after the binary exits and cd's the user
    // into the preserved worktree. Without the wrapper this file
    // is harmless — every subsequent `afk` invocation clears it.
    recordCdIntent(currentPath);
    if (!shellWrapperActive()) {
      // Match the install hint to the user's shell so fish users
      // don't get the bash `eval "$(...)"` form (which fails in
      // fish). Auto-detect falls back to bash if $SHELL is unset.
      const userShell = detectShellFromEnv(env.SHELL);
      const installHint =
        userShell === 'fish'
          ? `afk shell-init fish | source   (add to ~/.config/fish/config.fish)`
          : `eval "$(afk shell-init)"   (add to ~/.zshrc or ~/.bashrc)`;
      // eslint-disable-next-line no-console
      console.log(`  → cd ${currentPath}\n  → Or install one-time:  ${installHint}`);
    }
  };

  if (status.stdout.trim().length > 0) {
    preserveWorktree('uncommitted changes');
    return;
  }

  // Invariant: the `git status --porcelain` above reports untracked files
  // but NEVER ignored ones, so a tree whose only content is ignored reads
  // clean here and falls straight through to `remove --force` below. That
  // deletes a worktree-local `.env` or gitignored scratch file with no
  // warning and no recovery (#759) — this is the same defect the sweep
  // engine and the `worktree` tool's remove path already guard against, and
  // it is the most frequently executed removal path of the three.
  // Rebuildable output (node_modules/, dist/) stays non-protective on
  // purpose: treating it as protective would strand every worktree the
  // user ever finished with.
  // Contract: name the entry that ACTUALLY protected the tree. The old
  // wording ("non-rebuildable ignored files (e.g. .env)") read as a
  // finding, so a user who had no `.env` went hunting for a secret that
  // did not exist while the real cause — leftover test detritus, a
  // scratch dir — stayed invisible and the tree was preserved on every
  // single exit with nothing in the message to explain why.
  // ignoredProbeEarly was fetched concurrently with the status check above.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const ignoredProbe = ignoredProbeEarly!;
  if (ignoredProbe.protect) {
    preserveWorktree(
      ignoredProbe.because === 'git-failed'
        ? `the ignored-file probe failed (${ignoredProbe.detail}), so removal would be a guess`
        : `ignored local state \`git status\` cannot see: ${ignoredProbe.detail}`,
    );
    return;
  }

  const disposition = params.disposition ?? 'remove';
  if (disposition === 'keep-locked') {
    // External sweep constraint: lock BEFORE advertising preservation; a clean
    // dead-owner worktree without this lock may be reclaimed at the next sweep.
    try {
      await execFile('git', [
        '-C', repoRoot, 'worktree', 'lock',
        '--reason', `afk: kept on exit ${new Date().toISOString()}`,
        currentPath,
      ]);
    } catch (err) {
      const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `Worktree cleanup: could not lock ${currentPath} (${message}). It is preserved now, but a later sweep may reclaim it.`,
      );
    }
    preserveWorktree('kept on exit');
    return;
  }
  if (disposition === 'keep-unlocked') {
    // Deliberately NOT locked: nobody chose to keep this tree (the input
    // surface was gone), so it is preserved as a grace window and left
    // sweep-eligible rather than pinned forever. Say so, because "preserved"
    // alone would imply the durability that only a lock provides.
    preserveWorktree('kept on exit (not locked — a later sweep may reclaim it)');
    return;
  }

  try {
    await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', currentPath]);
  } catch (err) {
    const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `Worktree cleanup: 'git worktree remove --force ${currentPath}' failed (${message}). Manual removal may be needed.`,
    );
    return;
  }

  try {
    await execFile('git', ['-C', repoRoot, 'branch', '-d', currentBranch]);
  } catch (err) {
    const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
    // eslint-disable-next-line no-console
    console.warn(`Could not delete branch '${currentBranch}': ${message}`);
  }
}
