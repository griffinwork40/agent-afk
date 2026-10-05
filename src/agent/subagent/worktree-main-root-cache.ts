/**
 * Memoized per-cwd worktree main-root resolver extracted from SubagentManager.
 *
 * Forks overwhelmingly share one cwd, so this collapses N git subprocesses
 * to one per distinct cwd for the whole manager lifetime.
 *
 * @module agent/subagent/worktree-main-root-cache
 */

import { resolveWorktreeMainRoot } from '../worktree/worktree-read-root.js';

/**
 * Cache that memoises `resolveWorktreeMainRoot` results keyed by cwd.
 *
 * `undefined` MAP VALUE means resolved-and-none (so `.has()` distinguishes
 * "not yet resolved" from "resolved to none"), allowing callers to avoid a
 * repeated git subprocess on cache hit for paths outside a linked worktree.
 */
export class WorktreeMainRootCache {
  private readonly cache = new Map<string, string | undefined>();

  /**
   * Resolve (and memoize) the main-repo root for a worktree `cwd`.
   * Returns the main repository root when `cwd` is inside a linked git
   * worktree distinct from the main worktree, else `undefined`.
   * Best-effort — never throws.
   */
  async resolve(cwd: string): Promise<string | undefined> {
    if (this.cache.has(cwd)) {
      return this.cache.get(cwd);
    }
    const mainRoot = await resolveWorktreeMainRoot(cwd);
    this.cache.set(cwd, mainRoot);
    return mainRoot;
  }

  /**
   * Invalidate the cached entry for `cwd`. Called when a worktree at the same
   * path is deleted and recreated mid-session so the next fork resolves fresh.
   */
  invalidate(cwd: string): void {
    this.cache.delete(cwd);
  }
}
