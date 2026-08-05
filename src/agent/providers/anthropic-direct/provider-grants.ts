/**
 * Per-session path-grant and cwd state for {@link AnthropicDirectProvider}.
 *
 * Extracted from `provider-runtime.ts` (#824 split) as a whole concern: the
 * shared root arrays, the non-revocable resolve base, the live cwd, and the
 * {@link PathGrantManager} that mediates them all move together because they
 * are only ever read and written as a unit.
 *
 * Owning them here also makes the sharing contract explicit — see
 * {@link ProviderGrantState.readRoots}.
 *
 * @module agent/providers/anthropic-direct/provider-grants
 */

import { PathGrantManager } from '../../tools/grant-manager.js';
import { pathContainmentBypassed } from '../../permission-policy.js';

/**
 * The grant/cwd half of a provider's per-session mutable state.
 *
 * One instance per provider instance. `resolveProvider()` constructs a fresh
 * provider per session precisely so this state cannot leak across concurrent
 * `AgentSession`s under `afk farm new N` parallel dispatch.
 */
export class ProviderGrantState {
  /**
   * Mutable read-root list shared by reference across all per-query
   * dispatchers. Mutations via `addReadRoot`/`revokeRoot` on any dispatcher
   * are immediately visible to the next query's dispatcher because they all
   * point at the same array. Initialized from `AgentConfig.readRoots` (or
   * from `[cwd]` as fallback) on the first `query()` call.
   *
   * Invariant: callers mutate this array IN PLACE (`length = 0` + `push`).
   * Reassigning it would silently detach every already-built dispatcher.
   */
  private _readRoots: string[] | undefined;
  /** Mutable write-root list — same shared-reference pattern as {@link _readRoots}. */
  private _writeRoots: string[] | undefined;
  /** The first cwd ever seen — non-revocable, mirrors the dispatcher-level guard. */
  private _initialResolveBase: string | undefined;
  /**
   * Tracks the most recently-set cwd (initial from `ensureInitialized`,
   * updated by `cwdDependentsFactory` on each `setCwd` call). Used to find
   * the prior cwd entry in the root arrays so it can be swapped in place
   * instead of accumulating stale entries.
   *
   * Distinct from {@link _initialResolveBase}, which is fixed at session start
   * and preserved as the /allow-dir non-revocable anchor even across renames.
   */
  private _currentCwd: string | undefined;
  /**
   * The session's current permission mode, refreshed on each `query()`. Read by
   * `getGrants()` so the path-approval hook sees `allowAll` in bypassPermissions
   * mode (the per-query dispatcher gets the same signal via `buildDispatcher`).
   */
  private _permissionMode = 'default';

  /**
   * Shared grant-state machine (issues #361/#362). Hooks bind provider
   * semantics: lazy `ensureInitialized` init, the session's INITIAL
   * resolveBase as the non-revocable anchor (fixed across worktree renames),
   * `allowAll` derived from the current permission mode, and per-call
   * sessionId threading (no construction-bound default). See
   * grant-manager.ts for the divergence catalogue.
   */
  readonly manager = new PathGrantManager({
    getReadRoots: () => this._readRoots,
    getWriteRoots: () => this._writeRoots,
    ensureInitialized: () => this.ensureInitialized(),
    getProtectedRoot: () => this._initialResolveBase,
    getAllowAll: () => pathContainmentBypassed(this._permissionMode),
  });

  /** The shared read-root array, by reference. Undefined before first init. */
  get readRoots(): string[] | undefined {
    return this._readRoots;
  }

  /** The shared write-root array, by reference. Undefined before first init. */
  get writeRoots(): string[] | undefined {
    return this._writeRoots;
  }

  get currentCwd(): string | undefined {
    return this._currentCwd;
  }

  set currentCwd(cwd: string | undefined) {
    this._currentCwd = cwd;
  }

  get permissionMode(): string {
    return this._permissionMode;
  }

  set permissionMode(mode: string) {
    this._permissionMode = mode;
  }

  /**
   * Lazily initialise the shared root arrays if `query()` has not yet been
   * called (e.g. when /allow-dir runs before the first turn).
   */
  ensureInitialized(cwd?: string): void {
    if (!this._readRoots) {
      const defaultRoots = cwd ? [cwd] : [];
      this._readRoots = defaultRoots.slice();
      this._writeRoots = defaultRoots.slice();
      // Capture the first non-empty cwd as the non-revocable resolveBase.
      // Mirrors SessionToolDispatcher's resolveBase guard so /allow-dir can't
      // strip containment from the session's original working directory.
      if (cwd && !this._initialResolveBase) {
        this._initialResolveBase = cwd;
      }
      // Track the current cwd for in-place migration on subsequent
      // `cwdDependentsFactory` calls (worktree rename / setCwd path).
      if (cwd && !this._currentCwd) {
        this._currentCwd = cwd;
      }
    }
  }
}
