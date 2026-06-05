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
