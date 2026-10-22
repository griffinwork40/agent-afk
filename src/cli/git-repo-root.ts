/**
 * Resolve the shared git repository root for a given working directory.
 *
 * Uses `git rev-parse --git-common-dir` (NOT `--show-toplevel`) so that both
 * the main checkout and any linked worktrees resolve to the same root. For a
 * worktree at `/repo/.afk-worktrees/my-branch`, `--git-common-dir` returns
 * `/repo/.git`, whose dirname is `/repo` — the shared repo root. Results are
 * memoized by cwd string so repeated calls (e.g. per-entry in /resume
 * filtering) pay the execFileSync cost at most once per directory.
 */

import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';

const cache = new Map<string, string | undefined>();

/**
 * Return the shared git repo root for `cwd` (defaults to `process.cwd()`),
 * or `undefined` when the directory is not inside a git repository.
 *
 * Result is the absolute path of the directory that *contains* the `.git`
 * common dir — i.e. the repo root shared by main checkout and all worktrees.
 */
export function resolveRepoRoot(cwd?: string): string | undefined {
  const dir = cwd ?? process.cwd();
  if (cache.has(dir)) return cache.get(dir);
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    const root = dirname(resolve(dir, raw));
    cache.set(dir, root);
    return root;
  } catch {
    cache.set(dir, undefined);
    return undefined;
  }
}
