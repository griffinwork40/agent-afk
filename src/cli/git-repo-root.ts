/**
 * Resolve the shared git common-dir path for a given working directory.
 *
 * Uses `git rev-parse --git-common-dir` (NOT `--show-toplevel`) so that both
 * the main checkout and any linked worktrees resolve to the same identity. For
 * a worktree at `/repo/.afk-worktrees/my-branch`, `--git-common-dir` returns
 * `/repo/.git` — the shared common dir path used as the repo identity. Results
 * are memoized by cwd string so repeated calls (e.g. per-entry in /resume
 * filtering) pay the execFileSync cost at most once per directory.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';

const cache = new Map<string, string | undefined>();

/**
 * Return the resolved git common-dir path for `cwd` (defaults to
 * `process.cwd()`), or `undefined` when the directory is not inside a git
 * repository.
 *
 * Result is the absolute path of the git common dir itself (e.g.
 * `/repo/.git`), shared by the main checkout and all worktrees. This value
 * is used as a stable repo identity: two cwds belong to the same repo when
 * their resolved common-dir paths are equal. Note: this is NOT the repo root
 * directory — it is the `.git` dir (or equivalent for separate-git-dir repos).
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
    const root = resolve(dir, raw);
    cache.set(dir, root);
    return root;
  } catch {
    cache.set(dir, undefined);
    return undefined;
  }
}
