/**
 * Worktree-only sentences of the subagent identity preamble, split out of
 * `identity-preamble.ts` (which sits at the file-size ceiling).
 *
 * Invariant: every sentence here must be true for a child whose cwd is under
 * `.afk-worktrees/<slug>/`, so the caller emits them only in that case. The
 * stash hazard is structural; the scratch-dir sentence holds because afk
 * excludes `.afk-scratch/` in the repo's shared `info/exclude` at creation and
 * again just before the teardown dirty check (`worktree-scratch.ts`).
 *
 * @module agent/subagent/identity-preamble.worktree
 */

import { extractWorktreePath, isWorktreeCwd } from '../manifest/worktree.js';
import { AFK_SCRATCH_DIR } from '../worktree/worktree-scratch.js';

/**
 * Sentence appended to the identity preamble when the child's cwd is inside a
 * linked afk worktree. Exported for tests.
 *
 * Invariant: every clause must be true for a child whose cwd is under
 * `.afk-worktrees/`. The hazard (shared stash) is structural; the alternatives
 * (`git diff`/`git apply`, rescue branch) work in any worktree.
 */
export const WORKTREE_STASH_RULE =
  'Never run `git stash` push/pop/apply/drop/clear (or bare `git stash`) in this worktree: ' +
  'the stash stack (refs/stash) is shared with every other worktree of this repo and a mutating ' +
  'stash operation can silently consume or corrupt stashes from other agents or the main checkout ' +
  '(incident 2026-10-21). To set changes aside: `git diff > <file-in-worktree>` then `git apply <file>`, ' +
  'or commit to a rescue branch (`git switch -c rescue-<name> && git add <paths> && git commit`). ' +
  '`git stash list`, `show`, `create`, `store`, and `branch` are still fine.';

/**
 * Scratch-dir rule. `scratchPath` is the absolute `.afk-scratch/` of the
 * child's worktree. Exported for tests.
 */
export function worktreeScratchRule(scratchPath: string): string {
  return (
    'Put throwaway files (commit message bodies, PR bodies, issue comments, any scratch file) in ' +
    `\`${scratchPath}\`: git ignores it and it is deleted with the worktree. ` +
    'An untracked file anywhere else in the tree stops the worktree from being cleaned up.'
  );
}

/** Worktree-only preamble paragraphs for `cwd`; empty outside a worktree. */
export function renderWorktreeRules(cwd: string | undefined): string[] {
  if (cwd === undefined || !isWorktreeCwd(cwd)) return [];
  const root = extractWorktreePath(cwd);
  const rules = [WORKTREE_STASH_RULE];
  if (root !== undefined) rules.push(worktreeScratchRule(`${root}/${AFK_SCRATCH_DIR}/`));
  return rules;
}
