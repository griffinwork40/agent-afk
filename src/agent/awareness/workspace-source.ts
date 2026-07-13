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
 * Run a single `git` command in `cwd` and return trimmed stdout.
 *
 * Contract: returns `null` on any failure (non-zero status, signal, spawn
 * error). By default an empty-but-successful stdout ALSO collapses to `null`,
 * since an empty branch name or remote URL is meaningless. Pass
 * `allowEmpty: true` when empty output is itself a valid, distinct result —
 * notably `git status --porcelain`, whose empty output means "clean tree" and
 * MUST be distinguished from a failed status call. Without this flag a clean
 * repo was indistinguishable from a git error and reported `dirty: null`
 * instead of `dirty: false` (see gatherWorkspace).
 */
function gitOutput(cwd: string, args: string[], allowEmpty = false): string | null {
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
    if (out === null) return null;
    return out.length > 0 || allowEmpty ? out : null;
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

  // Porcelain status: one line per dirty file. Empty output = clean tree.
  // `allowEmpty: true` is load-bearing here — a clean repo emits empty stdout
  // with exit 0, which must be read as "clean" (dirty:false, count:0), NOT
  // conflated with a failed status call. Without it, gitOutput collapses
  // empty→null and a clean checkout wrongly reports dirty:null/dirtyCount:null.
  const statusRaw = gitOutput(cwd, ['status', '--porcelain'], true);
  let dirty: boolean | null = false;
  let dirtyCount: number | null = 0;
  if (statusRaw !== null) {
    // Each non-empty line is one dirty file; '' (clean) yields zero lines.
    const lines = statusRaw.split('\n').filter((l) => l.trim().length > 0);
    dirty = lines.length > 0;
    dirtyCount = lines.length;
  } else {
    // statusRaw === null now means git status genuinely FAILED (not merely
    // clean). HEAD was already validated above, so this is an unexpected error
    // — surface it as null rather than a misleading "clean".
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
