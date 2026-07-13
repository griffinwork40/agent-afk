/**
 * Read-scope inheritance for forked sub-agents (#416/#441 successor).
 *
 * Invariant: a forked read-only sub-agent must be able to READ everything its
 * parent could read. Writes are a separate, stricter axis (a fork stays
 * write-confined to its own cwd / worktree / explicit writeRoots) — this module
 * governs ONLY the read allow-list.
 *
 * History: the prior fix (#416) granted a worktree fork the main-repo root as a
 * read root, but only when `resolveWorktreeMainRoot` succeeded — it fails
 * silently on any `git rev-parse` error, re-confining the child to `[cwd]`
 * (#441 added a debug log but not a fix). Meanwhile a fork under an *unconfined*
 * top-level session (a plain `afk`/`afk i` with no `-w` → `resolveBase`
 * undefined → reads anywhere) got a concrete cwd and became confined to that
 * cwd, so it could no longer read sibling `.afk-worktrees/*` trees NOR
 * `~/.afk/state` paths that pervade its prompt/context — every such read was
 * hard-blocked by the path-approval hook (forks cannot prompt), and the child
 * spun on retried denials until a wall-clock timeout. This module replaces the
 * fragile single-grant with a uniform "child read scope ⊇ parent read scope"
 * rule that also covers the unconfined-parent case.
 *
 * The single source of truth is {@link computeInheritedReadRoots}, a pure
 * function called at the fork choke point (`SubagentManager.forkSubagent`) and,
 * for transitive correctness, when a child builds the manager for its own
 * grandchildren (`buildChildConfig`).
 *
 * @module agent/subagent-read-scope
 */

import path from 'path';

/**
 * A read root that admits any path on the volume — the honest expression of
 * "inherit an unconfined parent's read scope". `resolveAndContain` treats a
 * path as allowed iff it is inside SOME read root; the filesystem root contains
 * every absolute path, so this grants read-open (writes remain governed by the
 * separate writeRoots list). Derived from a base path so the volume root is
 * correct cross-platform (`/` on posix, `C:\` on win32).
 */
export function readOpenRootFor(base: string | undefined): string {
  const resolved = path.resolve(base ?? process.cwd());
  return path.parse(resolved).root || path.sep;
}

/**
 * The parent session's read-scope inputs, as returned by
 * {@link SubagentManager.getReadScopeInputs}. Threaded through the skill /
 * inline-skill / compose dispatch contexts so those paths compute a forked
 * child's read scope the same way the `agent` tool does (see
 * {@link resolveChildManagerReadRoots}). `undefined` in either field carries
 * the same meaning it does for {@link computeInheritedReadRoots}.
 */
export interface ReadScopeInputs {
  parentReadRoots: string[] | undefined;
  parentCwd: string | undefined;
}

/**
 * Compute the `parentReadRoots` a skill- / inline- / compose-built
 * {@link SubagentManager} should carry, given the parent session's read scope
 * ({@link ReadScopeInputs}, from `getReadScopeInputs`) and the child manager's
 * own cwd.
 *
 * This is the single choke point that keeps skill/inline dispatch SYMMETRIC
 * with the `agent` tool: `subagent-executor.ts` reads `getReadScopeInputs()`
 * off the parent manager and threads the result through `child-config.ts` as a
 * grandchild manager's `parentReadRoots`. Skill managers historically passed
 * only `cwd`, so their forks derived read scope from cwd alone and silently
 * NARROWED whenever the parent session was read-open (or `/allow-dir`-widened)
 * beyond `[cwd, mainRoot]` — the residual of #544 this closes (#547). Seeding a
 * child manager's `parentReadRoots` with the result propagates the parent's
 * full read scope transitively; `forkSubagent` still folds in the worktree main
 * root, so callers need not resolve it here.
 *
 * Returns `undefined` when there is nothing broader than the child's own cwd to
 * grant (the caller then omits `parentReadRoots` and the manager's existing
 * cwd-derivation stands, byte-for-byte unchanged).
 */
export function resolveChildManagerReadRoots(
  parentScope: ReadScopeInputs | undefined,
  childCwd: string | undefined,
): string[] | undefined {
  // `parentScope === undefined` means the caller could not determine the parent
  // session's scope (getReadScopeInputs unwired — a test stub or a surface that
  // predates this wiring), NOT that the parent is unconfined. Distinguish the
  // two: return undefined so the manager's existing cwd-derivation stands
  // (byte-for-byte pre-#547 behaviour). Only a KNOWN unconfined parent
  // (`{ parentReadRoots: undefined, parentCwd: undefined }`) yields a read-open
  // child, via computeInheritedReadRoots below.
  if (parentScope === undefined) return undefined;
  return computeInheritedReadRoots({
    parentReadRoots: parentScope.parentReadRoots,
    parentCwd: parentScope.parentCwd,
    childCwd,
  });
}

export interface InheritedReadRootsArgs {
  /**
   * The parent session's explicit read roots, or `undefined` to derive the
   * parent's scope from {@link parentCwd}. A caller that pins `readRoots`
   * (e.g. `afk farm`, which deliberately confines each branch worker) is
   * handled UPSTREAM — this function is only invoked when the child left
   * `readRoots` unset — so an explicit value here always means "the parent is
   * confined to exactly these roots" (used for transitive propagation).
   */
  parentReadRoots: string[] | undefined;
  /**
   * The parent session's cwd. `undefined` signals an UNCONFINED parent (a
   * top-level session with no worktree → `resolveBase` undefined → reads
   * anywhere); a defined value is the parent's containment base.
   */
  parentCwd: string | undefined;
  /** The child fork's effective cwd (its own tree). */
  childCwd: string | undefined;
  /**
   * The main-repo root when {@link childCwd} is inside a linked git worktree,
   * else undefined. Folded into the union so a worktree fork can read the main
   * checkout and — since sibling worktrees live under `<mainRoot>/.afk-worktrees/`
   * and containment is lexical — every sibling worktree too.
   */
  worktreeMainRoot?: string | undefined;
  /**
   * The AFK state directory (`~/.afk/state`, or the `$AFK_STATE_DIR` override).
   * Folded into a CONFINED fork's read union so it can reach the runtime-state
   * paths that pervade its prompt/context — skill-preflight staged inputs (e.g.
   * a PR diff a `/review` fan-out hands its children), todos, transcripts, and
   * per-session ledgers — none of which a worktree/confined parent's cwd+repo
   * roots lexically contain, so every such read was hard-denied (forks cannot
   * prompt) until a wall-clock timeout.
   *
   * Pass the STATE dir ONLY — NEVER `~/.afk/config`, which holds `afk.env`
   * credentials: read scope must not widen to secrets. Ignored by the unconfined
   * branch (already read-open). `undefined` adds nothing, so a caller that omits
   * it gets byte-for-byte the pre-fix behaviour.
   */
  afkStateRoot?: string | undefined;
}

/**
 * Compute the read roots a forked child should inherit, or `undefined` to leave
 * the provider default (`[childCwd]`) in place.
 *
 * Rules:
 *  - Parent UNCONFINED (`parentReadRoots` undefined AND `parentCwd` undefined):
 *    the child inherits read-open — `[readOpenRootFor(childCwd)]`. Writes stay
 *    confined to the child's own cwd/writeRoots.
 *  - Parent CONFINED (explicit `parentReadRoots`, or a defined `parentCwd`):
 *    the child gets the UNION of the parent's roots, its own cwd, the worktree
 *    main root, and the AFK state dir ({@link InheritedReadRootsArgs.afkStateRoot})
 *    — never narrower than the parent (child read scope ⊇ parent read scope),
 *    never write-relevant.
 *
 * Returns a de-duplicated, resolved array. `undefined` only when there is
 * genuinely nothing to grant (no child cwd, no parent scope) — the caller then
 * leaves the provider default untouched.
 */
export function computeInheritedReadRoots(args: InheritedReadRootsArgs): string[] | undefined {
  const { parentReadRoots, parentCwd, childCwd, worktreeMainRoot, afkStateRoot } = args;
  const resolvedChildCwd =
    childCwd !== undefined && childCwd !== '' ? path.resolve(childCwd) : undefined;

  // Unconfined parent (no explicit roots AND no cwd) → child inherits read-open.
  // A confined child would be NARROWER than its parent, which is the bug this
  // module exists to prevent.
  if (parentReadRoots === undefined && parentCwd === undefined) {
    // A child with no cwd is ALREADY unconfined — its resolveBase is undefined,
    // which bypasses containment entirely (see _cwd-utils.ts) — so leave
    // readRoots unset. Only a child WITH a cwd (whose reads would otherwise be
    // confined to `[cwd]`) needs the explicit read-open grant to match the
    // parent's reach.
    return resolvedChildCwd !== undefined ? [readOpenRootFor(resolvedChildCwd)] : undefined;
  }

  // Confined parent → union(childCwd, parent roots, worktree main root).
  const parentRoots = parentReadRoots ?? (parentCwd !== undefined ? [parentCwd] : []);
  const roots = new Set<string>();
  if (resolvedChildCwd !== undefined) roots.add(resolvedChildCwd);
  for (const r of parentRoots) {
    if (r !== undefined && r !== '') roots.add(path.resolve(r));
  }
  if (worktreeMainRoot !== undefined && worktreeMainRoot !== '') {
    roots.add(path.resolve(worktreeMainRoot));
  }
  // The AFK state dir (~/.afk/state) — runtime state a confined fork's cwd+repo
  // roots do not lexically contain (skill-preflight inputs, todos, transcripts,
  // session ledgers). Callers pass the state dir only, never ~/.afk/config
  // (credentials). Added AFTER the cwd/parent/worktree roots so the size checks
  // below correctly see it as a broadening grant.
  if (afkStateRoot !== undefined && afkStateRoot !== '') {
    roots.add(path.resolve(afkStateRoot));
  }

  // Nothing to grant, OR the only root is the child's own cwd (which equals the
  // provider's `[cwd]` default) → leave readRoots unset so the default stands.
  // This keeps the change surgical: a fork that inherits nothing broader than
  // its own cwd is byte-for-byte unchanged from the pre-fix behaviour.
  if (roots.size === 0) return undefined;
  if (roots.size === 1 && resolvedChildCwd !== undefined && roots.has(resolvedChildCwd)) {
    return undefined;
  }
  return [...roots];
}
