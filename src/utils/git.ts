/**
 * Shared git utilities — thin wrappers around `git` CLI invocations for
 * operations used across the CLI, agent, and daemon layers.
 *
 * Contract: no caller outside this module runs its own `git rev-parse` just to
 * find the repo root. All such paths import `resolveRepoRoot` from here.
 */

import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { execFileAsync } from './exec-file.js';

/**
 * Minimal shape expected by the injectable `execFile` option of
 * `resolveRepoRoot`. Compatible with the `ExecFileFn` type defined in
 * `src/cli/commands/interactive/worktree.ts` and `worktree-sweep.ts` so
 * those callers can pass their own promisified `execFile` for test isolation.
 */
export type ExecFileForGit = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolution strategy for `resolveRepoRoot`.
 *
 * - `'show-toplevel'` (default): runs `git rev-parse --show-toplevel`. Correct
 *   for standalone repos and for callers that want the working-tree root of the
 *   repo they are currently inside. Safe to use from both the main checkout and
 *   from linked worktrees when you want THAT worktree's root.
 *
 * - `'git-common-dir'`: runs `git rev-parse --git-common-dir` and returns
 *   `dirname` of the result. Correct when the caller is running inside a linked
 *   worktree and needs the MAIN repo root (the common `.git` directory's parent),
 *   rather than the worktree's own checkout path. Used by the `/worktree` slash
 *   command so it always resolves the canonical `.afk-worktrees/` parent.
 */
export type RepoRootMode = 'show-toplevel' | 'git-common-dir';

/**
 * Options for the async `resolveRepoRoot()`.
 */
export interface ResolveRepoRootOptions {
  /** Working directory passed to `git`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Which git flag to use. Defaults to `'show-toplevel'`. */
  mode?: RepoRootMode;
  /**
   * Injectable executor — replaces the default `promisify(execFile)`. Used by
   * callers (e.g. the `/worktree` slash command, boot-prune) that already carry
   * a test-stub `ExecFileFn` and want consistent behaviour without forking a
   * real child process in unit tests.
   */
  execFile?: ExecFileForGit;
}

/**
 * Minimal shape expected by the injectable `execFileSync` option of
 * `resolveRepoRootSync`. Compatible with the Node.js `execFileSync` signature
 * for the subset of options this module uses.
 */
export type ExecFileSyncForGit = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore'] },
) => string;

/**
 * Options for the sync `resolveRepoRootSync()`.
 */
export interface ResolveRepoRootSyncOptions {
  /** Working directory passed to `git`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Which git flag to use. Defaults to `'show-toplevel'`. */
  mode?: RepoRootMode;
  /**
   * Value returned when `git rev-parse` fails (not a git repository, or git is
   * absent). When `undefined` (the default) the error is re-thrown.
   */
  fallback?: string;
  /**
   * Injectable executor — replaces the default `execFileSync`. Used by unit
   * tests to avoid spawning real child processes.
   */
  execFileSync?: ExecFileSyncForGit;
}

/**
 * Resolve the git repository root asynchronously.
 *
 * @throws `Error('Not in a git repository.')` if `git rev-parse` fails and no
 *   `fallback` was supplied (async variant always throws — callers that want a
 *   fallback should use `resolveRepoRootSync` with the `fallback` option, or
 *   wrap in a try/catch).
 */
export async function resolveRepoRoot(options?: ResolveRepoRootOptions): Promise<string> {
  const cwd = options?.cwd ?? process.cwd();
  const mode = options?.mode ?? 'show-toplevel';
  const exec: ExecFileForGit = options?.execFile ?? ((file, args) => execFileAsync(file, args, { cwd }));

  try {
    if (mode === 'git-common-dir') {
      const result = await exec('git', ['rev-parse', '--git-common-dir'], { cwd });
      const raw = result.stdout.trim();
      if (!raw) throw new Error('Not in a git repository.');
      const absoluteGitDir = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
      return dirname(absoluteGitDir);
    } else {
      const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
      const root = result.stdout.trim();
      if (!root) throw new Error('Not in a git repository.');
      return root;
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Not in a git repository.') throw err;
    throw new Error('Not in a git repository.');
  }
}

/**
 * Resolve the git repository root synchronously.
 *
 * When `options.fallback` is provided it is returned instead of throwing when
 * `git rev-parse` fails. This preserves the "return cwd on failure" semantics
 * used by spine-hook and the `/spine` slash command.
 */
export function resolveRepoRootSync(options?: ResolveRepoRootSyncOptions): string {
  const cwd = options?.cwd ?? process.cwd();
  const mode = options?.mode ?? 'show-toplevel';
  const execSync: ExecFileSyncForGit = options?.execFileSync ?? execFileSync;

  try {
    if (mode === 'git-common-dir') {
      const raw = execSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!raw) throw new Error('Not in a git repository.');
      const absoluteGitDir = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
      return dirname(absoluteGitDir);
    } else {
      const root = execSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!root) throw new Error('Not in a git repository.');
      return root;
    }
  } catch (err) {
    if (options?.fallback !== undefined) return options.fallback;
    if (err instanceof Error && err.message === 'Not in a git repository.') throw err;
    throw new Error('Not in a git repository.');
  }
}
