/**
 * Workspace baseline gatherer (Phase 2).
 *
 * Captures git state via synchronous child-process calls. `gatherWorkspace`
 * itself is stateless and always performs 4 `spawnSync` calls (branch, SHA,
 * status, remote); whether to cache the result or call it fresh for liveness
 * is the caller's choice (see `runtime-source.ts`, which calls it per-read so
 * the model sees current state).
 *
 * Design:
 *   - Uses `spawnSync` rather than `execSync` to avoid shell injection on
 *     cwd paths. All git calls are argument-list-safe.
 *   - Returns a fully-null `RuntimeWorkspace` on any error (git not found,
 *     non-git directory, any non-zero exit). Caller sees "not a git repo"
 *     vs "a clean repo at main" without throwing.
 *   - Shell-free: no `shell: true`. Arguments are passed as a string array.
 *
 * @module agent/awareness/workspace-source
 */

import { spawnSync } from 'child_process';
import type { RuntimeWorkspace } from './types.js';

/** The null sentinel returned when any git call fails. */
const NULL_WORKSPACE: RuntimeWorkspace = {
  branch: null,
  headSha: null,
  dirty: null,
  dirtyCount: null,
  remoteUrl: null,
};

/**
 * Run a single `git` command in `cwd` and return trimmed stdout, or `null`
 * on any failure (non-zero status, signal, error, or empty output).
 */
function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      // Cap output at 4 KiB — branch names / remote URLs can't exceed that.
      // Prevents runaway output from a hypothetical `git status` in a repo
      // with 100k dirty files from blocking the session.
      maxBuffer: 4096,
      // No shell — args are already safe.
      shell: false,
    });
    if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
      return null;
    }
    const out = typeof result.stdout === 'string' ? result.stdout.trim() : null;
    return out !== null && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Gather the git workspace baseline for `cwd`.
 *
 * Returns `NULL_WORKSPACE` (all fields null) when `cwd` is not a git
 * repository, git is not installed, or any individual git command fails.
 * Individual field nullability is finer-grained: `branch` being null while
 * `headSha` is set indicates a detached HEAD.
 *
 * This function performs 4 synchronous process spawns on every call. Callers
 * that need only a one-time baseline should cache the result; callers that need
 * liveness (e.g. `get_runtime_state` reflecting the current dirty state) call
 * it fresh each time and accept the per-call spawn cost.
 */
export function gatherWorkspace(cwd: string): RuntimeWorkspace {
  // Verify this is a git repo first — avoids running 3 more commands when it's not.
  const headShaRaw = gitOutput(cwd, ['rev-parse', '--short', 'HEAD']);
  if (headShaRaw === null) {
    // Not a git repo, git not found, or no commits yet.
    return { ...NULL_WORKSPACE };
  }

  // Branch name — symbolic-ref fails on detached HEAD, falls back to null.
  const branchRaw = gitOutput(cwd, ['symbolic-ref', '--short', 'HEAD']);

  // Porcelain status: one line per dirty file. Empty output = clean.
  const statusRaw = gitOutput(cwd, ['status', '--porcelain']);
  let dirty: boolean | null = false;
  let dirtyCount: number | null = 0;
  if (statusRaw !== null) {
    // Each non-empty line is one dirty file.
    const lines = statusRaw.split('\n').filter((l) => l.trim().length > 0);
    dirty = lines.length > 0;
    dirtyCount = lines.length;
  }
  // statusRaw === null means git status itself failed — leave dirty/dirtyCount null.
  // We know HEAD is valid (checked above), so null status means an unexpected error.
  if (statusRaw === null) {
    dirty = null;
    dirtyCount = null;
  }

  // Remote URL for 'origin'. Failure (no remote) → null.
  const remoteUrl = gitOutput(cwd, ['remote', 'get-url', 'origin']);

  return {
    branch: branchRaw,
    headSha: headShaRaw,
    dirty,
    dirtyCount,
    remoteUrl,
  };
}
