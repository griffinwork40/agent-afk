/**
 * Defensive sandbox containment helper.
 *
 * Contract: every operator that writes to disk must call assertInsideSandbox
 * before the write so that a path-traversal bug (e.g. a bad symlink or a
 * crafted rel path) is caught before it can reach the real AFK_HOME.
 *
 * @module whatif/operators/sandbox-guard
 */

import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Environment } from '../types.js';

/**
 * Resolve the real path of `dir` (creating it first if missing so realpathSync
 * does not throw) and verify it is inside either `env.home` or `env.cwd`.
 * Throws a descriptive Error if containment is violated.
 *
 * @param dir   - The directory to check (must already exist or be created).
 * @param env   - The sandbox environment whose boundaries are enforced.
 */
export function assertInsideSandbox(dir: string, env: Environment): void {
  // Create the directory if missing so realpathSync can resolve it.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const real = realpathSync(dir);
  const home = realpathSync(env.home);
  const cwd = realpathSync(env.cwd);

  // Allow exact match (the dir IS the sandbox root) or containment.
  // Use path.relative so containment works on all platforms (Windows uses '\').
  // A sibling like /tmp/x/homeEvil is NOT inside /tmp/x/home — relative()
  // would return '../homeEvil', triggering the '..' guard.
  const insideHome = isInside(home, real);
  const insideCwd = isInside(cwd, real);

  if (!insideHome && !insideCwd) {
    const homeSuffix = home.endsWith(path.sep) ? home : home + path.sep;
    const cwdSuffix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
    throw new Error(
      `[whatif] sandbox containment violation: attempted write to "${real}" which is outside ` +
        `env.home "${homeSuffix}" and env.cwd "${cwdSuffix}". ` +
        `This is a bug in the operator — only sandbox paths may be mutated.`,
    );
  }
}

/**
 * Returns true if `child` is `root` itself or is contained within `root`.
 * Uses `path.relative` so it is separator-aware on all platforms.
 *
 * `rel === ''` means child equals root (covered by the fast-path above, but
 * also included here to match the repo's containment idiom).
 */
function isInside(root: string, child: string): boolean {
  if (root === child) return true;
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
