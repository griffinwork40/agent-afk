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

  // Allow exact match (the dir IS the sandbox root) or containment (startsWith with separator)
  const insideHome = real === home || real.startsWith(trailingSlash(home));
  const insideCwd = real === cwd || real.startsWith(trailingSlash(cwd));

  if (!insideHome && !insideCwd) {
    throw new Error(
      `[whatif] sandbox containment violation: attempted write to "${real}" which is outside ` +
        `env.home "${trailingSlash(home)}" and env.cwd "${trailingSlash(cwd)}". ` +
        `This is a bug in the operator — only sandbox paths may be mutated.`,
    );
  }
}

function trailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}
