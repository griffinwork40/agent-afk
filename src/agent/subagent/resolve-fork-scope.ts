/**
 * Fork-time read- and write-scope resolution for `SubagentManager.forkSubagent`.
 *
 * Extracted from `../subagent.ts` to keep the fork method focused on
 * orchestration. Every function here is a pure computation over its inputs —
 * except `resolveReadScope`, which calls the manager's cached
 * `resolveMainRootForCwd` for the worktree main-root lookup.
 *
 * @module agent/subagent/resolve-fork-scope
 */

import path from 'path';
import { computeInheritedReadRoots } from '../subagent-read-scope.js';
import { getAfkStateDir, getAgentFrameworkDir } from '../../paths.js';

// ── Read-scope resolution ──────────────────────────────────────────────

export interface ResolveReadScopeArgs {
  /** The parent manager's parentReadRoots (may be undefined = derive from cwd). */
  parentReadRoots: string[] | undefined;
  /** The parent manager's parentCwd (may be undefined = unconfined). */
  parentCwd: string | undefined;
  /** The child's effective cwd (config.cwd ?? parentCwd). */
  effectiveChildCwd: string | undefined;
  /** The caller's explicit config.readRoots, if any (pins suppress inheritance). */
  callerReadRoots: string[] | undefined;
  /** The caller's explicit config.extraReadRoots, if any. */
  callerExtraReadRoots: string[] | undefined;
  /**
   * Async lookup: resolve the worktree main root for a given cwd. Expected to
   * be `this.resolveMainRootForCwd.bind(this)` from the manager, which caches
   * per-cwd.
   */
  resolveMainRoot: (cwd: string) => Promise<string | undefined>;
}

/**
 * Compute the inherited + composed read roots for a forked child.
 *
 * Replaces the inline ~100-LOC block that was at lines 362–459 of
 * `forkSubagent`. Pure delegation to `computeInheritedReadRoots` with the
 * Gap A/B/C grants and the extraReadRoots composition.
 *
 * Returns `undefined` when the caller pinned `readRoots` (inheritance
 * suppressed) or when there is nothing broader than the child's own cwd to
 * grant.
 */
export async function resolveReadScope(
  args: ResolveReadScopeArgs,
): Promise<string[] | undefined> {
  const {
    parentReadRoots,
    parentCwd,
    effectiveChildCwd,
    callerReadRoots,
    callerExtraReadRoots,
    resolveMainRoot,
  } = args;

  // Caller pinned readRoots → inheritance suppressed entirely. extraReadRoots
  // flows through the DISTINCT field precisely so the pin is never touched
  // (Invariant #1 from the original site).
  if (callerReadRoots !== undefined) return undefined;

  // ── Inherited scope from parent ──
  const parentUnconfined =
    parentReadRoots === undefined && parentCwd === undefined;

  let worktreeMainRoot: string | undefined;
  if (!parentUnconfined && effectiveChildCwd !== undefined) {
    worktreeMainRoot = await resolveMainRoot(effectiveChildCwd);
    // Gap B: child cwd yields no distinct main root → fall back to parent cwd.
    if (
      worktreeMainRoot === undefined &&
      parentCwd !== undefined &&
      parentCwd !== effectiveChildCwd
    ) {
      worktreeMainRoot = await resolveMainRoot(parentCwd);
    }
  }

  let inheritedReadRoots = computeInheritedReadRoots({
    parentReadRoots,
    parentCwd,
    childCwd: effectiveChildCwd,
    worktreeMainRoot,
    // Gap A: grant ~/.afk/state to confined forks (never credentials).
    ...(parentUnconfined ? {} : { afkStateRoot: getAfkStateDir() }),
    // Gap C: grant ~/.afk/agent-framework to confined forks.
    ...(parentUnconfined ? {} : { afkFrameworkRoot: getAgentFrameworkDir() }),
  });

  // ── Compose extraReadRoots (additive, #662) ──
  if (
    callerExtraReadRoots !== undefined &&
    callerExtraReadRoots.length > 0
  ) {
    // Invariant #2: never confine an unconfined child — only compose when the
    // child is (or will be) confined.
    const willBeConfined =
      inheritedReadRoots !== undefined || effectiveChildCwd !== undefined;
    if (willBeConfined) {
      const base =
        inheritedReadRoots ??
        (effectiveChildCwd !== undefined ? [effectiveChildCwd] : []);
      inheritedReadRoots = [
        ...new Set([
          ...base,
          ...callerExtraReadRoots.map((r) => path.resolve(r)),
        ]),
      ];
    }
  }

  return inheritedReadRoots;
}

// ── Write-root composition ─────────────────────────────────────────────

/**
 * Compose explicit write roots with the child's cwd so the child never loses
 * write access to its own tree (#435).
 *
 * Returns `undefined` when the caller did not pass writeRoots — the provider's
 * default `[cwd]` stands.
 */
export function composeWriteRoots(
  callerWriteRoots: string[] | undefined,
  effectiveChildCwd: string | undefined,
): string[] | undefined {
  if (callerWriteRoots === undefined || callerWriteRoots.length === 0) {
    return undefined;
  }
  const base = effectiveChildCwd !== undefined ? [effectiveChildCwd] : [];
  return [...new Set([...base, ...callerWriteRoots])];
}
