/**
 * The path-root breadth guard: rejects a `cwd`, `writeRoots`, or `readRoots`
 * entry that is a filesystem root, the home dir, an ancestor of home, or an
 * AFK-anchored credential root.
 *
 * Extracted from `input-parse.ts` (#782) — a pure move, zero logic change. The
 * host file's three grant fields (`cwd`, `writeRoots`, `readRoots`) each feed
 * the child's grant snapshot and the bash-restriction hook's grant filter
 * (`deriveRestrictedSubstrings`), where an ancestor-based containment check
 * drops any credential root beneath a granted path; a too-broad grant on ANY
 * of the three silently empties that child's credential floor, so the rejection
 * must be identical across all three call sites.
 *
 * @module agent/tools/subagent/root-validation
 */

import { isAbsolute, parse as parsePath, relative as relativePath } from 'node:path';
import { homedir } from 'node:os';
import { realpathSafe } from '../handlers/_cwd-utils.js';
import { getAfkHome, getAfkStateDir } from '../../../paths.js';
import { warnAfkHomeRejectedOnce } from '../afk-home-warn.js';

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