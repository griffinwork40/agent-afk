/**
 * The path-root breadth guard: rejects a `cwd`, `writeRoots`, or `readRoots`
 * entry that is a filesystem root, the home dir, an ancestor of home, an
 * AFK-anchored credential root, or an ancestor of ANY bash credential root.
 *
 * Extracted from `input-parse.ts` (#782). The host file's three grant fields
 * (`cwd`, `writeRoots`, `readRoots`) each feed the child's grant snapshot and
 * the bash-restriction hook's grant filter (`deriveRestrictedSubstrings`),
 * where an ancestor-based containment check drops any credential root beneath
 * a granted path; a too-broad grant on ANY of the three silently empties that
 * child's credential floor, so the rejection must be identical across all
 * three call sites.
 *
 * Two guards live here, in widening order: {@link isTooBroadRoot} (the #740
 * extraction, anchored on `/`, home, and the AFK dirs) and
 * {@link ungatedSensitiveRoot} (#852, anchored on every credential root the
 * bash floor protects).
 *
 * @module agent/tools/subagent/root-validation
 */

import { isAbsolute, parse as parsePath, relative as relativePath } from 'node:path';
import { homedir } from 'node:os';
import { realpathSafe } from '../handlers/_cwd-utils.js';
import { getAfkHome, getAfkStateDir } from '../../../paths.js';
import { warnAfkHomeRejectedOnce } from '../afk-home-warn.js';
import { deriveRestrictedSubstrings } from '../hooks/bash-restriction-hook.js';

// Home targets for the shared breadth guard below. Computed once at module
// scope — `homedir()` is stable per process, so there is no need to
// re-resolve it on every `parseAgentInput` call. Check against BOTH the
// lexical home and its realpath: if the home dir is itself behind a symlink,
// a symlink-resolved candidate would otherwise slip past a lexical-only home
// comparison.
const HOME_TARGETS: readonly string[] = [...new Set([homedir(), realpathSafe(homedir())])];

/**
 * The AFK-anchored breadth targets, resolved PER CALL rather than at module
 * scope.
 *
 * Invariant: unlike `homedir()`, these are env-driven (`AFK_HOME`,
 * `AFK_STATE_DIR`) and therefore NOT stable per process — hoisting them would
 * snapshot one spelling at import and never observe a runtime relocation. This
 * is the same trap the read denylist documents: derive inside the call, not at
 * module scope.
 *
 * Why they belong in the breadth guard at all: a granted root that is at-or-
 * above the AFK home empties that child's AFK-anchored credential floor by
 * exactly the route `$HOME` emptied the home-anchored one. The bash hook's
 * grant filter (`deriveRestrictedSubstrings`) drops any candidate an ancestor
 * of which has been granted, and `${AFK_HOME}/config` is such a candidate. A
 * relocated `AFK_HOME` (say `/opt/my-afk`) is neither the home dir nor an
 * ancestor of it, so the home-only targets did not catch it.
 *
 * A malformed env var throws; caught and skipped so a bad value can never
 * loosen the guard, and surfaced once via the shared warn latch.
 */
function afkBreadthTargets(): string[] {
  const targets: string[] = [];
  for (const derive of [getAfkHome, getAfkStateDir]) {
    try {
      const dir = derive();
      targets.push(dir, realpathSafe(dir));
    } catch (err) {
      warnAfkHomeRejectedOnce(err);
    }
  }
  return targets;
}

/**
 * True when `candidate` is "too broad" to pre-grant as a `cwd`, `writeRoots`,
 * or `readRoots` entry: a filesystem root, the home dir itself, or an
 * ANCESTOR of home (home lexically inside it → relative(candidate, home)
 * neither escapes with '..' nor is absolute).
 *
 * Shared by all three fields (#740): each one ends up in the child's grant
 * snapshot and feeds the bash-restriction hook's grant filter
 * (`deriveRestrictedSubstrings`), where an ancestor-based containment check
 * drops any credential root beneath a granted path. A too-broad grant on ANY
 * of the three — not just `readRoots`, which already carried this guard —
 * silently empties that child's credential floor, so the rejection must be
 * identical across all three call sites.
 */
export function isTooBroadRoot(candidate: string): boolean {
  if (candidate === parsePath(candidate).root) return true;
  return [...HOME_TARGETS, ...afkBreadthTargets()].some((h) => {
    const rel = relativePath(candidate, h);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * The complete, UNFILTERED bash credential-candidate list — the exact set
 * `deriveRestrictedSubstrings` starts from before applying its grant filter.
 * The empty snapshot is what makes it unfiltered: with no resolveBase and no
 * roots, its containment check can drop nothing.
 *
 * Invariant: derived per call, never hoisted to module scope. The underlying
 * list is env-driven (`AFK_READ_DENYLIST`, `AFK_HOME`), so a module-scope
 * snapshot would freeze one spelling at import and never observe a runtime
 * relocation — the same trap `afkBreadthTargets` documents above. Reusing the
 * hook's own exported deriver (rather than re-listing roots here) is what keeps
 * the two in lockstep: a root added to the bash floor later is automatically
 * un-grantable, with no second list to remember.
 */
function bashSensitiveRoots(): readonly string[] {
  return deriveRestrictedSubstrings({ resolveBase: undefined, readRoots: [], writeRoots: [] });
}

/**
 * The bash credential root that granting `candidate` would un-gate, or
 * `undefined` when it would un-gate none.
 *
 * Invariant: this is the ANCESTOR half of the breadth guard, and it exists
 * because {@link isTooBroadRoot} anchors only on the filesystem root, home, and
 * the AFK dirs — it says nothing about the many narrower directories that still
 * sit ABOVE a credential root. `~/Library/Application Support` is the canonical
 * case (#852): not home, not an AFK dir, and not read-denied (only the
 * per-browser subtrees under it are), yet granting it drops that whole vendor
 * tree — browser secrets included — out of the child's bash restriction via the
 * ancestor-based containment check in `deriveRestrictedSubstrings`.
 *
 * Invariant: provenance comes from the CALL SITE, not from a tag on the grant.
 * The three fields guarded here are parsed off a MODEL-authored `agent` tool
 * call, while every operator grant path (`/allow-dir`, the path-approval
 * elicitation approvals, persisted-permission restore) reaches the grant
 * manager without passing through this module. That asymmetry is the whole
 * point: the documented "an explicit grant lifts the bash floor" contract
 * survives intact for the operator, and only the model loses the ability to
 * lift that floor for itself with no human in the loop.
 *
 * Containment direction matches the filter this defends: `relative(candidate,
 * sensitive)` neither escaping with '..' nor being absolute means the candidate
 * IS the sensitive root or is an ancestor of it. A grant INSIDE a sensitive
 * tree is therefore not rejected here — it does not lift the enclosing root,
 * and `isReadDenied` already refuses the denylisted subtrees for `readRoots`.
 * Checked on both the lexical and the symlink-resolved spelling, same as
 * {@link isTooBroadRoot}, because the containment layer realpaths granted roots
 * before comparison (#664).
 */
export function ungatedSensitiveRoot(candidate: string): string | undefined {
  const forms = [...new Set([candidate, realpathSafe(candidate)])];
  for (const sensitive of bashSensitiveRoots()) {
    for (const form of forms) {
      const rel = relativePath(form, sensitive);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return sensitive;
    }
  }
  return undefined;
}