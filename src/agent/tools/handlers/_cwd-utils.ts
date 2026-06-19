/**
 * Shared path-resolution and containment utilities for tool handlers.
 *
 * Centralises the `resolveAndContain` logic that was previously copy-pasted
 * into every handler. All six filesystem handlers (read-file, write-file,
 * edit-file, glob, grep, list-directory) import from here.
 *
 * @module agent/tools/handlers/_cwd-utils
 */

import path from 'path';
import { realpathSync } from 'fs';
import type { ToolHandlerContext } from '../types.js';

// Invariant: symlink containment must be resolved at the filesystem level, not
// lexically. A symlink that lives INSIDE a granted root but points OUTSIDE it
// would bypass `path.relative` containment if we compare unresolved paths.
// `realpathSafe` resolves symlinks on the true filesystem before any
// containment comparison, so such escape attempts are caught. We handle the
// not-yet-existing-path case (e.g. new write_file targets) by recursively
// resolving the nearest existing ancestor and re-appending trailing segments —
// this prevents throwing on legitimate new-file writes while still resolving
// all existing symlinks in the ancestor chain.
export function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // Path may not exist yet (new write target). Resolve the nearest existing
    // ancestor, then re-append the trailing segment(s).
    const dir = path.dirname(p);
    const base = path.basename(p);
    if (dir === p) return p; // reached filesystem root
    return path.join(realpathSafe(dir), base);
  }
}

// Invariant: the realpath of a granted root is filesystem-stable within a
// session — adding or revoking a root mutates the roots array, not what
// realpathSafe(root) returns for a given string. Under this module's
// non-adversarial threat model (a granted root's symlink is not retargeted
// mid-session), caching root -> realpath across calls is safe and removes the
// N+1 realpath syscalls that resolveAndContain / wouldBeRestricted otherwise
// pay on EVERY typed-file-tool call (linear in granted-root count). The
// candidate path is always resolved fresh; only roots are memoized.
const rootRealpathCache = new Map<string, string>();

function realpathRoot(root: string): string {
  const cached = rootRealpathCache.get(root);
  if (cached !== undefined) return cached;
  const real = realpathSafe(root);
  rootRealpathCache.set(root, real);
  return real;
}

/**
 * Test-only: clear the cross-call root realpath cache so suites that point the
 * same root string at different real targets across cases don't see a stale
 * entry. Production never needs this (root realpaths are session-stable).
 */
export function _resetRootRealpathCacheForTests(): void {
  rootRealpathCache.clear();
}

/**
 * Resolve `inputPath` to an absolute path (using `resolveBase` for relative
 * inputs) and verify it is contained within at least one of `allowedRoots`.
 *
 * @param inputPath   - The raw path string from the tool input.
 * @param context     - The current handler context (may be undefined for
 *                      back-compat callers that provide no context).
 * @param mode        - `'read'` or `'write'` — affects the error message noun
 *                      only; the containment logic is identical.
 * @returns The resolved absolute path.
 * @throws  When a `resolveBase` is set and the resolved path falls outside
 *          every allowed root.
 */
export function resolveAndContain(
  inputPath: string,
  context: ToolHandlerContext | undefined,
  mode: 'read' | 'write' = 'read',
): string {
  const resolveBase = context?.resolveBase ?? context?.cwd;

  // Resolve to absolute, anchoring relative paths against resolveBase.
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(resolveBase ?? process.cwd(), inputPath);

  // Bypass mode: the session runs in `bypassPermissions`, which disables all
  // path containment. Admit any path (no throw). This is the same switch the
  // path-approval hook consults to skip its prompt, so the two stay in sync.
  if (context?.allowAll === true) {
    return abs;
  }

  // No base set — no containment enforcement.
  if (resolveBase === undefined) {
    return abs;
  }

  // Resolve symlinks on the candidate path before containment comparison so a
  // symlink inside a root that points outside cannot escape containment.
  const realAbs = realpathSafe(abs);

  // Build the effective allow-list.
  const roots: string[] =
    mode === 'read'
      ? (context?.readRoots ?? [resolveBase])
      : (context?.writeRoots ?? [resolveBase]);

  // Path is allowed if it is inside ANY root (compare real paths throughout).
  for (const root of roots) {
    const realRoot = realpathRoot(root);
    const rel = path.relative(realRoot, realAbs);
    if (!rel.startsWith('..')) {
      return abs;
    }
  }

  // All roots rejected.
  const rootList = roots.map((r) => `\`${r}\``).join(', ');
  const noun = mode === 'read' ? 'read roots' : 'write roots';
  throw new Error(`Path \`${inputPath}\` is outside the allowed ${noun} [${rootList}].`);
}

/**
 * Non-throwing variant of {@link resolveAndContain}: returns the resolution
 * verdict instead of throwing on a containment failure. Used by the
 * path-approval PreToolUse hook to decide whether to prompt the user BEFORE
 * the handler's resolveAndContain throws.
 *
 * Contract:
 * - `resolved` is always the absolute path that `resolveAndContain` would
 *   produce. Callers can pass it straight to `addReadRoot/addWriteRoot` on
 *   the grant manager after an approval prompt.
 * - `restricted: false` means the path is contained within at least one
 *   allowed root (or no `resolveBase` is set, which disables enforcement).
 * - `restricted: true` means EVERY root rejected the path; the caller should
 *   either elicit user approval or block.
 *
 * Mirrors `resolveAndContain`'s logic exactly — duplicating ~10 LOC is cheaper
 * than restructuring the throwing variant around a result object, and the
 * unit test suite pins both functions to the same containment semantics.
 */
export function wouldBeRestricted(
  inputPath: string,
  context: ToolHandlerContext | undefined,
  mode: 'read' | 'write' = 'read',
): { restricted: boolean; resolved: string; roots: string[] } {
  const resolveBase = context?.resolveBase ?? context?.cwd;

  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(resolveBase ?? process.cwd(), inputPath);

  // Bypass mode (bypassPermissions): never restricted, so the path-approval
  // hook does not prompt. Mirrors the short-circuit in `resolveAndContain`.
  if (context?.allowAll === true) {
    return { restricted: false, resolved: abs, roots: [] };
  }

  if (resolveBase === undefined) {
    // No containment enforcement — never restricted.
    return { restricted: false, resolved: abs, roots: [] };
  }

  // Resolve symlinks on the candidate path before containment comparison so a
  // symlink inside a root that points outside cannot escape containment.
  const realAbs = realpathSafe(abs);

  const roots: string[] =
    mode === 'read'
      ? (context?.readRoots ?? [resolveBase])
      : (context?.writeRoots ?? [resolveBase]);

  for (const root of roots) {
    const realRoot = realpathRoot(root);
    const rel = path.relative(realRoot, realAbs);
    if (!rel.startsWith('..')) {
      return { restricted: false, resolved: abs, roots };
    }
  }

  return { restricted: true, resolved: abs, roots };
}
