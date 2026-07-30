/**
 * Non-rebuildable ignored-file probe for the worktree sweep.
 *
 * Invariant: `git status --porcelain` — the sweep's only dirty signal — reports
 * untracked files but NEVER ignored ones. A worktree whose sole contents are
 * ignored therefore reads CLEAN, becomes eligible for `git worktree remove
 * --force`, and has those files deleted along with the checkout. Committed work
 * is never lost that way (branch refs live in the shared `.git`), but a
 * worktree-local `.env`, a scratch fixture, or an un-ignored-by-habit secrets
 * file is unrecoverable (#759).
 *
 * Contract: this probe distinguishes REBUILDABLE ignored artifacts from
 * non-rebuildable local state, and it must. Treating *any* ignored entry as
 * protective would make effectively every worktree immortal — `node_modules/`
 * and `dist/` are ignored in every checkout — defeating the sweep entirely and
 * regrowing the very leak it exists to prevent. So the default stays
 * "reapable": only an ignored entry that does NOT match a known-rebuildable
 * pattern protects the tree.
 *
 * Fail-safe direction: anything unrecognised is treated as non-rebuildable
 * (protect), and a git failure also protects — mirroring the sweep's existing
 * `catch { isDirty = true }` posture, where the safe answer is "leave it alone".
 *
 * @module agent/worktree-ignored-probe
 */

import type { ExecFileFn } from './worktree-sweep.js';

/**
 * Ignored paths that a build can regenerate from committed sources. Matched
 * against the repo-relative path git reports. Directory patterns may occur at
 * any package boundary so monorepo output is treated the same as root output.
 *
 * Deliberately NOT listed (so they protect the tree): `.env*`, `.vscode/`,
 * `.idea/`, and anything else unrecognised — editor and environment files are
 * hand-authored local state, not build output.
 */
const REBUILDABLE_IGNORED_PATTERNS: readonly RegExp[] = [
  // AFK owns and recreates this bookkeeping marker.
  /^\.afk-worktree-meta\.json$/,
  // Dependency trees
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.pnpm(-store)?\//,
  /(?:^|\/)\.yarn\//,
  /(?:^|\/)bower_components\//,
  /(?:^|\/)vendor\/bundle\//,
  // Build output
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)out\//,
  /(?:^|\/)lib-cov\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)\.nuxt\//,
  /(?:^|\/)\.svelte-kit\//,
  /(?:^|\/)\.output\//,
  /(?:^|\/)target\//,
  // Caches
  /(?:^|\/)\.turbo\//,
  /(?:^|\/)\.parcel-cache\//,
  /(?:^|\/)\.vite\//,
  /(?:^|\/)\.cache\//,
  /(?:^|\/)\.gradle\//,
  /(?:^|\/)__pycache__\//,
  /(?:^|\/)\.pytest_cache\//,
  /(?:^|\/)\.mypy_cache\//,
  /(?:^|\/)\.ruff_cache\//,
  /(?:^|\/)\.venv\//,
  /(?:^|\/)venv\//,
  // Coverage + incremental-build metadata
  /(?:^|\/)coverage\//,
  /(?:^|\/)\.nyc_output\//,
  /\.tsbuildinfo$/,
  /^\.eslintcache$/,
  /^\.stylelintcache$/,
  // OS + log noise
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /\.log$/,
];

/** True when `relPath` is ignored build output or cache a rebuild would restore. */
export function isRebuildableIgnoredEntry(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '') return true;
  return REBUILDABLE_IGNORED_PATTERNS.some((re) => re.test(normalized));
}

/**
 * True when the worktree holds at least one ignored entry that a rebuild would
 * NOT restore — i.e. removing the checkout would destroy something the user
 * cannot get back.
 *
 * Uses `--ignored` in its default (traditional) mode on purpose: it collapses an
 * ignored DIRECTORY into a single `!! node_modules/` line instead of listing
 * every file beneath it, which keeps this cheap on a populated worktree.
 */
export async function hasNonRebuildableIgnoredFiles(
  execFile: ExecFileFn,
  worktreePath: string,
): Promise<boolean> {
  let stdout: string;
  try {
    const result = await execFile('git', [
      '-C', worktreePath, 'status', '--porcelain', '--ignored',
    ]);
    stdout = result.stdout;
  } catch {
    return true; // unreadable → protect, never force-remove on a guess
  }
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('!!')) continue;
    const entry = line.slice(2).trim();
    if (entry === '') continue;
    if (!isRebuildableIgnoredEntry(entry)) return true;
  }
  return false;
}
