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
import { relative, isAbsolute } from 'node:path';
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

  if (!isInside(real, home) && !isInside(real, cwd)) {
    throw new Error(
      `[whatif] sandbox containment violation: attempted write to "${real}" which is outside ` +
        `env.home "${home}" and env.cwd "${cwd}". ` +
        `This is a bug in the operator — only sandbox paths may be mutated.`,
    );
  }
}

/**
 * Return true when `child` is inside `root` or IS `root` (exact match).
 *
 * Uses `path.relative`-based containment — the same idiom as the sibling
 * `_cwd-utils.ts` handler — so there is one containment idiom across the
 * whatif sandbox rather than two. This correctly handles:
 *
 *   - Exact match: `path.relative(root, root)` returns `''`, which does not
 *     start with `..` and is not absolute → accepted.
 *   - `..`-prefixed siblings (e.g. `/sandbox-evil` vs `/sandbox`): relative
 *     returns a `..`-prefixed string → rejected.
 *   - Windows different-drive paths (e.g. root on `C:`, child on `D:`):
 *     `path.win32.relative` returns a drive-qualified absolute string instead
 *     of a `..`-prefixed one; the `!isAbsolute(rel)` guard catches this.
 *
 * @param child - The already-realpath-resolved candidate path.
 * @param root  - The already-realpath-resolved sandbox boundary.
 */
function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  // rel === '' means child === root (exact match); an empty string does not
  // start with '..' and is not absolute, so the condition below admits it.
  // On Windows, when root and child are on different drives, relative() returns
  // a drive-qualified absolute path (e.g. 'D:\evil'), which isAbsolute catches.
  return !rel.startsWith('..') && !isAbsolute(rel);
}
