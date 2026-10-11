/**
 * Filesystem utility helpers shared across agent-afk.
 *
 * This module standardises the identical `access`-based existence check that
 * appears in several places across the codebase (issue #3265). Rather than
 * each call site duplicating a try/catch around `fs.access`, callers import
 * `pathExists` from here.
 *
 * Scope deliberately narrow — this is NOT a general-purpose fs wrapper:
 *   - `pathExists` covers only the `access(F_OK)` pattern for files and dirs.
 *   - lstat / symlink / type predicates live in their own call sites: replacing
 *     them with this helper would lose type information (is it a dir? a link?).
 *
 * @module utils/fs
 */

import { access } from 'node:fs/promises';

/**
 * Return `true` when the path is accessible (exists and is readable by the
 * current process), `false` otherwise.
 *
 * This is the async counterpart of `existsSync` / `fs.existsSync`. Unlike
 * `existsSync` it does not block the event loop, and unlike a raw `access`
 * call it never throws — callers do not need a try/catch.
 *
 * Note: there is an inherent TOCTOU race between this check and any subsequent
 * operation on the path. Use it for optimistic early-returns and diagnostics,
 * not as a guard before writes (prefer atomic writes that do not need the check
 * in the first place).
 *
 * @param path - Absolute or relative path to test.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
