/**
 * Resolve the MAIN repository working-tree root for a git worktree.
 *
 * # Why
 *
 * A session — and especially a forked subagent — running with `cwd` set to a
 * linked git worktree (e.g. `afk interactive -w`, whose worktrees live at
 * `<repoRoot>/.afk-worktrees/<slug>`) is confined by the tool dispatcher's
 * read-root containment (`tools/handlers/_cwd-utils.resolveAndContain`) to
 * `[cwd]`. But the worktree is a *checkout of the main repo*, and main-repo
 * absolute paths pervade the context a subagent sees: the system prompt's
 * `# Environment` block, skill prompts, the parent session's messages, and the
 * model's own priors. When a subagent tries `read_file <mainRepo>/package.json`
 * the lexical containment check rejects it as "outside the allowed read roots"
 * — and, unlike a top-level session, a subagent cannot resolve this
 * interactively: the path-approval hook auto-denies forked children (see the
 * `parentSessionId` guard in `tools/hooks/path-approval-hook.ts`). The subagent
 * is locked in with no remedy.
 *
 * Granting the main repo root as a READ root (never a write root — writes stay
 * confined to the worktree for isolation) removes the lock. Reading main-repo
 * files from a worktree is not a privilege escalation: it is the same project.
 *
 * # Tradeoff (accepted)
 *
 * When the model uses a *main-repo* absolute path, the read now returns the
 * main worktree's copy of the file rather than the worktree's — which can
 * differ if the worktree has uncommitted edits to that path. This is strictly
 * better than the pre-fix behavior (a hard error), and relative paths continue
 * to resolve against `cwd` (the worktree), so worktree-local content is still
 * reachable the normal way. Rewriting main-repo paths to their worktree
 * equivalents was rejected as far more complex and error-prone (not every
 * main-repo path has a worktree twin — `.git`, sibling worktrees).
 *
 * # Contract
 *
 * Returns the main repo root ONLY when `cwd` is inside a *linked* worktree
 * whose main root is a distinct path. Returns undefined when:
 *   - `cwd` is undefined or empty,
 *   - `cwd` is not inside a git repository,
 *   - `cwd` is inside the MAIN worktree (its root or a subdir) — nothing
 *     distinct to grant,
 *   - git resolution fails AND `cwd` is not an afk-managed worktree.
 *
 * Git-free fallback (#544/#554 completion): when `git rev-parse` throws on an
 * afk-managed worktree (`<mainRoot>/.afk-worktrees/<slug>`), the main root is
 * recovered LEXICALLY from the path. This closes the gap where a pruned or
 * mid-sweep worktree admin dir makes git fail on the fork's OWN cwd — a case
 * re-resolving via git (from any cwd, e.g. #554's parent-cwd fallback) cannot
 * fix — which otherwise silently re-confines the fork to `[worktree]` and hard-
 * denies every main-repo read.
 *
 * Best-effort: never throws. A git failure on a NON-afk path still degrades to
 * today's behavior (worktree-only read root).
 *
 * @module agent/worktree-read-root
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { debugLog } from '../utils/debug.js';

const execFilePromise = promisify(execFileCb);

/** Minimal `execFile` shape — injectable so tests can drive it without git. */
export type ExecFileFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (cmd, args) =>
  execFilePromise(cmd, args) as Promise<{ stdout: string; stderr: string }>;

/**
 * Git-free recovery of the main-repo root for an afk-managed worktree.
 *
 * Invariant: afk worktrees are created at `<mainRoot>/.afk-worktrees/<slug>`
 * (see `tools/handlers/worktree-managed.ts` and `worktree-sweep.ts`), so the
 * main root is the path prefix preceding the `.afk-worktrees/` segment —
 * derivable WITHOUT git. This is the load-bearing fallback for the case
 * #544/#554 left open: when `git rev-parse` fails on the fork's OWN worktree
 * cwd (a pruned/mid-sweep admin dir), re-resolving via git — from any cwd —
 * cannot recover the main root, so a purely lexical path is the only remedy.
 *
 * Returns undefined for any path not under an `.afk-worktrees/` segment (a
 * relocated `AFK_WORKTREE_BASE`, or a non-afk worktree), leaving today's
 * best-effort `undefined` in place there.
 */
function lexicalAfkWorktreeMainRoot(cwd: string): string | undefined {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}.afk-worktrees${path.sep}`;
  const idx = resolved.indexOf(marker);
  // idx <= 0 covers "not found" (−1) and the degenerate "at the filesystem
  // root" (0), where there is no non-empty prefix to grant.
  if (idx <= 0) return undefined;
  return resolved.slice(0, idx);
}

/**
 * Resolve the main repository root for a worktree at `cwd`. See the module
 * header for the full contract. Returns undefined when there is no distinct
 * main root to grant, or on any git failure (best-effort).
 */
export async function resolveWorktreeMainRoot(
  cwd: string | undefined,
  execFile: ExecFileFn = defaultExecFile,
): Promise<string | undefined> {
  if (cwd === undefined || cwd === '') return undefined;
  try {
    // One `git rev-parse` yields both values, in request order:
    //   line 1 = --git-common-dir  (the .git shared by all linked worktrees;
    //            from a linked worktree it is <mainRoot>/.git, from the main
    //            worktree it is a relative ".git")
    //   line 2 = --show-toplevel   (the root of the worktree containing cwd)
    const { stdout } = await execFile('git', [
      '-C',
      cwd,
      'rev-parse',
      '--git-common-dir',
      '--show-toplevel',
    ]);
    const lines = stdout.split('\n').map((l) => l.trim());
    const commonDirRaw = lines[0];
    const topLevelRaw = lines[1];
    if (!commonDirRaw || !topLevelRaw) return undefined;

    // --git-common-dir may be relative (from the main worktree) — anchor it.
    const absCommonDir = path.isAbsolute(commonDirRaw)
      ? commonDirRaw
      : path.resolve(cwd, commonDirRaw);
    const mainRoot = path.resolve(path.dirname(absCommonDir));
    const topLevel = path.resolve(topLevelRaw);

    // cwd sits inside the MAIN worktree (its root or a subdir) when the
    // containing worktree's toplevel equals the main root — no distinct main
    // repo to grant, so return undefined.
    if (mainRoot === topLevel) return undefined;

    return mainRoot;
  } catch (err) {
    // Not a git repo, git missing, or any other failure — best-effort. afk
    // worktrees encode their main root in the path, so try a git-free lexical
    // recovery FIRST: this is exactly the case #544/#554 left open — a
    // pruned/mid-sweep worktree admin dir makes `git rev-parse` throw on the
    // fork's OWN cwd, and re-resolving via git cannot help. Recovery keeps the
    // fork's main-repo read access instead of silently re-confining it.
    const lexical = lexicalAfkWorktreeMainRoot(cwd);
    if (lexical !== undefined) {
      debugLog(
        `[worktree-read-root] git rev-parse failed for cwd=${cwd}; recovered main ` +
          `root lexically as ${lexical} (afk worktree layout) — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return lexical;
    }
    // Non-afk path with no lexical anchor: the silent return re-confines a
    // forked child to `[worktree]` (the #416 symptom returns) with no signal,
    // so surface the degradation under AFK_DEBUG=1 — otherwise a subagent that
    // unexpectedly loses main-repo read access is undiagnosable (#441).
    debugLog(
      `[worktree-read-root] git rev-parse failed for cwd=${cwd}; child confined ` +
        `to worktree only — ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
