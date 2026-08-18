/**
 * Background-mode worktree lifecycle helpers.
 *
 * Extracted from worktree-managed.ts: thin wrappers that lock a worktree at
 * creation (so the sweep cannot race-reap it while a detached child runs) and
 * unlock + tear down when the background job settles via markTerminal().
 *
 * @module agent/tools/handlers/worktree-managed.background
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { teardownIsolatedWorktree, type IsolatedTeardownResult } from './worktree-managed.js';
import { debugLog } from '../../../utils/debug.js';

const defaultExecFile = promisify(execFileCb);

/**
 * Lock a freshly-created isolated worktree so the sweep engine cannot reap it
 * while a background child runs inside it. Called at creation time in the
 * executor, before the handle is registered with the background registry.
 * Best-effort: a lock failure is logged but does not prevent dispatch — the
 * occupancy heartbeat is a second line of defence.
 */
export async function lockWorktreeForBackground(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    await defaultExecFile('git', [
      '-C', repoRoot, 'worktree', 'lock',
      '--reason', 'afk: background-isolated-worktree in use by detached child',
      worktreePath,
    ]);
  } catch (err) {
    debugLog(
      `[isolation] failed to lock worktree for background child: ${String(err)}`,
    );
  }
}

/**
 * Unlock and tear down an isolated worktree after its background child
 * finishes. Called from markTerminal() in the background registry. Unlock
 * runs first (teardownIsolatedWorktree refuses locked trees); teardown
 * then removes a clean tree or preserves+relocks a dirty one.
 * Best-effort: never throws (called in a terminal-state callback path).
 */
export async function teardownBackgroundWorktree(args: {
  repoRoot: string;
  worktreePath: string;
}): Promise<IsolatedTeardownResult> {
  try {
    await defaultExecFile('git', [
      '-C', args.repoRoot, 'worktree', 'unlock', args.worktreePath,
    ]);
  } catch {
    // Already unlocked, or tree already removed — proceed to teardown.
  }
  return teardownIsolatedWorktree(args);
}
