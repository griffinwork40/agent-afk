/**
 * Module-scope helpers extracted from scheduler.ts to stay under the
 * 350-code-line ceiling. These are pure functions with no dependency on
 * the CronScheduler class — they existed as top-level exports/constants
 * in scheduler.ts and were moved here without modification.
 *
 * @module agent/daemon/scheduler.helpers
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ExecFileFn } from '../worktree-sweep.js';

/**
 * Wall-clock ceiling on a single `git` invocation inside the sweep.
 *
 * External constraint: git can block indefinitely on things that are not
 * errors — a credential prompt on a repo with an https remote, a stale NFS or
 * SMB handle, a network-mounted worktree whose server went away. The prune
 * tick's per-root loop is deliberately serial (one machine-global advisory
 * lock), so a single blocked child does not fail that root: it hangs the whole
 * tick forever and strands every root ordered behind it, which is precisely
 * the starvation the per-root try/catch was added to prevent. A timeout turns
 * that silent hang into a rejection the existing catch already handles.
 * Generous by design — a slow `git status` on a large worktree is normal.
 */
const PRUNE_GIT_TIMEOUT_MS = 120_000;

// Promisified once at module scope — the daemon's builtin worktree-prune task
// reuses the same node:child_process exec function on every tick; there is no
// reason to re-resolve it dynamically inside the handler.
const promisifiedPruneExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

/**
 * `promisifiedPruneExecFile` with a timeout merged into every call. Wrapping
 * here rather than at each `git` call site inside the sweep engine keeps the
 * engine's own signature untouched and applies the ceiling uniformly, including
 * to call sites added later.
 */
export const builtinPruneExecFile: ExecFileFn = (file, args, options) =>
  promisifiedPruneExecFile(file, args, { timeout: PRUNE_GIT_TIMEOUT_MS, ...options });

/**
 * Resolve the repo root for the builtin worktree-prune sweep. An explicit
 * `override` (AFK_WORKTREE_SWEEP_ROOT) wins; otherwise discover the repo
 * enclosing `cwd` via `git rev-parse --show-toplevel`. Returns `null` when the
 * cwd is not inside a git repository — the daemon's cwd is frequently $HOME
 * (launchd sets WorkingDirectory=homedir), so the caller skips gracefully
 * instead of erroring `fatal: not a git repository` on every nightly run.
 * Exported for unit testing with a stubbed execFile.
 */
export async function resolveWorktreePruneRoot(
  execFile: ExecFileFn,
  cwd: string,
  override: string | undefined,
): Promise<string | null> {
  if (override !== undefined && override.length > 0) return override;
  try {
    const top = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = top.stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Build a charset-safe witness `sessionLabel` for a daemon tick, shaped
 * `<sanitized-taskId>-<uuid>` so traces are greppable by task name yet each
 * tick still gets its own trace dir (a bare taskId would make repeated ticks
 * append to one ever-growing file — the factory treats a repeated label as
 * resume/append).
 *
 * Contract: the result always satisfies SESSION_ID_SAFE (/^[a-zA-Z0-9_-]+$/)
 * because getTraceDir() validates the label and throws otherwise, and a raw
 * taskId may legally contain '.', '/', or spaces.
 */
export function daemonTraceLabel(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'task'}-${randomUUID()}`;
}
