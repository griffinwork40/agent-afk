/**
 * Worktree detection helpers for the wave manifest system.
 *
 * Detects whether a manifest unit's cwd is inside an afk-managed worktree and
 * extracts the worktree root path for existence checks at resume time.
 *
 * @module agent/manifest/worktree
 */

import { existsSync } from 'node:fs';

/** The path segment that identifies afk-managed worktrees. */
const AFK_WORKTREES = '/.afk-worktrees/';

/**
 * True when `cwd` is inside an afk-managed worktree directory.
 *
 * @example
 * isWorktreeCwd('/repo/.afk-worktrees/my-branch/src') // true
 * isWorktreeCwd('/repo/src') // false
 */
export function isWorktreeCwd(cwd: string): boolean {
  return cwd.includes(AFK_WORKTREES);
}

/**
 * Extract the worktree root path from a cwd that is inside `.afk-worktrees/`.
 *
 * Returns undefined when `cwd` is not inside a worktree.
 *
 * @example
 * extractWorktreePath('/repo/.afk-worktrees/my-branch/src')
 * // → '/repo/.afk-worktrees/my-branch'
 *
 * extractWorktreePath('/repo/.afk-worktrees/my-branch')
 * // → '/repo/.afk-worktrees/my-branch'
 *
 * extractWorktreePath('/repo/src')
 * // → undefined
 */
export function extractWorktreePath(cwd: string): string | undefined {
  const idx = cwd.indexOf(AFK_WORKTREES);
  if (idx === -1) return undefined;
  const after = cwd.slice(idx + AFK_WORKTREES.length);
  const slash = after.indexOf('/');
  const name = slash === -1 ? after : after.slice(0, slash);
  if (name.length === 0) return undefined;
  return cwd.slice(0, idx + AFK_WORKTREES.length) + name;
}

/**
 * Check whether a unit's worktree still exists on disk.
 *
 * Returns:
 *   - `'ok'`      when there is no worktree, or the worktree exists.
 *   - `'missing'` when the unit had a worktree that has since been swept.
 */
export function checkWorktreePresence(worktreePath: string | undefined): 'ok' | 'missing' {
  if (worktreePath === undefined) return 'ok';
  return existsSync(worktreePath) ? 'ok' : 'missing';
}
