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
import type { ToolHandlerContext } from '../types.js';

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

  // No base set — no containment enforcement.
  if (resolveBase === undefined) {
    return abs;
  }

  // Build the effective allow-list.
  const roots: string[] =
    mode === 'read'
      ? (context?.readRoots ?? [resolveBase])
      : (context?.writeRoots ?? [resolveBase]);

  // Path is allowed if it is inside ANY root.
  for (const root of roots) {
    const rel = path.relative(root, abs);
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

  if (resolveBase === undefined) {
    // No containment enforcement — never restricted.
    return { restricted: false, resolved: abs, roots: [] };
  }

  const roots: string[] =
    mode === 'read'
      ? (context?.readRoots ?? [resolveBase])
      : (context?.writeRoots ?? [resolveBase]);

  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..')) {
      return { restricted: false, resolved: abs, roots };
    }
  }

  return { restricted: true, resolved: abs, roots };
}
