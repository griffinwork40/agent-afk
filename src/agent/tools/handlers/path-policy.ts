/**
 * Resolve-then-decide path policy (#3847).
 *
 * Contract: the credential floor ALWAYS precedes actor containment. Bypass,
 * unconfined scope, granted roots and scratch never override that floor.
 * Built-in read carve-outs and operator denylist precedence remain owned by
 * read-denylist.ts; write access has no carve-outs.
 *
 * Plain and native canonical forms are intentionally both retained: the read
 * floor uses plain realpath, while Windows write-floor protection requires
 * native long-name comparison as well. This is not an OS sandbox or an atomic
 * check-and-open; write handlers must retain dangling-target revalidation.
 */
import { safeRealpath, safeNativeRealpath, isCanonicalPathWriteDenied } from './write-denylist.js';
import { isCanonicalPathReadDenied } from './read-denylist.js';
import { decideActorContainment, resolvePolicyPath, type PathActorScope } from './path-policy.roots.js';
export type { PathActorScope } from './path-policy.roots.js';

export type PathAccessDecision =
  | { kind: 'allow'; resolved: string }
  | { kind: 'deny'; reason: 'credential'; matched: string; canonical: string; resolved: string }
  | { kind: 'deny'; reason: 'roots'; resolved: string; roots: string[] };

/** Omitted scope checks only the floor (back-compatible read-policy callers). */
export function decidePathAccess(
  rawPath: string,
  op: 'read' | 'write',
  scope?: PathActorScope,
  fallbackBase?: string,
): PathAccessDecision {
  const resolved = resolvePolicyPath(rawPath, scope, fallbackBase);
  const real = safeRealpath(resolved);
  const floor = op === 'read'
    ? isCanonicalPathReadDenied(real)
    : isCanonicalPathWriteDenied(real, safeNativeRealpath(resolved));
  if (floor.denied) {
    return { kind: 'deny', reason: 'credential', matched: floor.matched ?? real, canonical: real, resolved };
  }
  const containment = decideActorContainment(resolved, op, scope, fallbackBase);
  if (containment.restricted) {
    return { kind: 'deny', reason: 'roots', resolved, roots: containment.roots };
  }
  return { kind: 'allow', resolved };
}
