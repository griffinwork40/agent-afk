/** Actor-root containment shared by path policy and containment-only advisory callers. */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isWithinScratchRoot } from './scratch-roots.js';

export interface PathActorScope {
  resolveBase?: string | undefined;
  readRoots?: string[] | undefined;
  writeRoots?: string[] | undefined;
  allowAll?: boolean | undefined;
}

export interface PathContainment {
  restricted: boolean;
  resolved: string;
  roots: string[];
}

/** Native canonical form preserves Windows long-name containment semantics. */
export function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const dir = path.dirname(p);
    if (dir === p) return p;
    return path.join(realpathSafe(dir), path.basename(p));
  }
}

// Granted roots are session-stable under the non-adversarial containment model.
// Candidates are always fresh; do not cache candidate realpaths.
const rootRealpathCache = new Map<string, string>();
function realpathRoot(root: string): string {
  const cached = rootRealpathCache.get(root);
  if (cached !== undefined) return cached;
  const real = realpathSafe(root);
  rootRealpathCache.set(root, real);
  return real;
}

export function _resetRootRealpathCacheForTests(): void {
  rootRealpathCache.clear();
}

export function resolvePolicyPath(input: string, scope?: PathActorScope, fallbackBase?: string): string {
  return path.isAbsolute(input) ? input : path.resolve(scope?.resolveBase ?? fallbackBase ?? process.cwd(), input);
}

/** No credential floor here: approval and bash advisories need roots-only verdicts. */
export function decideActorContainment(
  resolved: string,
  mode: 'read' | 'write',
  scope?: PathActorScope,
  fallbackBase?: string,
): PathContainment {
  const resolveBase = scope?.resolveBase ?? fallbackBase;
  // Undefined base is deliberately UNCONFINED. Empty roots with a set base
  // deliberately deny all (apart from write scratch); never conflate the two.
  if (scope?.allowAll === true || resolveBase === undefined) {
    return { restricted: false, resolved, roots: [] };
  }
  const real = realpathSafe(resolved);
  const roots = mode === 'read' ? (scope?.readRoots ?? [resolveBase]) : (scope?.writeRoots ?? [resolveBase]);
  for (const root of roots) {
    const rel = path.relative(realpathRoot(root), real);
    // Different Windows drives produce an absolute relative() result.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { restricted: false, resolved, roots };
    }
  }
  // Scratch is WRITE-only and checked after canonicalization. It never
  // overrides the credential floor in decidePathAccess.
  return { restricted: !(mode === 'write' && isWithinScratchRoot(real)), resolved, roots };
}
