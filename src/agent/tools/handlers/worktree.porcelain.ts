/**
 * Porcelain-output parsing helpers for `git worktree list --porcelain`.
 *
 * Extracted from worktree.ts to keep that file within the 350-code-line
 * ceiling (#5387). These helpers are the "worktree registry lookup" concern:
 * parse the porcelain output, find an entry by path, and resolve a
 * caller-supplied slug/path to a registered entry or an error string.
 *
 * @module agent/tools/handlers/worktree.porcelain
 */

import { join, resolve, isAbsolute, sep } from 'node:path';
import type { ExecFileFn } from '../../worktree/worktree-sweep.js';
import type { RepoContext } from './worktree-managed.js';

export interface PorcelainEntry {
  path: string;
  branch?: string;
  locked: boolean;
}

export async function listRegisteredWorktrees(
  execFile: ExecFileFn,
  repoRoot: string,
): Promise<PorcelainEntry[]> {
  const out = await execFile('git', ['--no-optional-locks', '-C', repoRoot, 'worktree', 'list', '--porcelain']);
  const entries: PorcelainEntry[] = [];
  let current: PorcelainEntry | undefined;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), locked: false };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.startsWith('locked') && current) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Find the registered entry for `path`, or undefined. */
export async function findEntry(
  execFile: ExecFileFn,
  repoRoot: string,
  path: string,
): Promise<PorcelainEntry | undefined> {
  const entries = await listRegisteredWorktrees(execFile, repoRoot);
  return entries.find((e) => resolve(e.path) === resolve(path));
}

/** Resolve a caller-supplied path/slug to a registered entry, or return an error string. */
export async function resolveManagedWorktree(
  execFile: ExecFileFn,
  ctx: RepoContext,
  pathInput: string,
): Promise<PorcelainEntry | string> {
  let candidate: string;
  if (isAbsolute(pathInput)) {
    candidate = pathInput;
  } else if (pathInput.startsWith(`.afk-worktrees${sep}`)) {
    candidate = resolve(ctx.repoRoot, pathInput);
  } else {
    candidate = join(ctx.afkWorktreesRoot, pathInput);
  }
  if (!isPathWithin(candidate, ctx.afkWorktreesRoot)) {
    return `Refused: ${pathInput} is outside .afk-worktrees/. Pass a slug (e.g. "my-worktree") or a path under .afk-worktrees/ from a prior create/list result. Do not pass absolute paths outside .afk-worktrees/.`;
  }
  const entry = await findEntry(execFile, ctx.repoRoot, candidate);
  if (!entry) {
    return `No registered git worktree at ${candidate}. Run action "list" to see all managed worktrees and their current paths.`;
  }
  return entry;
}

/** True when `child` is `parent` or nested inside it. */
function isPathWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}
