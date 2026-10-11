/**
 * Shared utility for printing a mixed warning/error list from git-management
 * commands (branch prune, worktree sweep).
 *
 * Items starting with `[ERROR]` are written to stderr in `palette.error`
 * colour; all others are written to stdout in `palette.warning` colour.
 *
 * @module cli/commands/print-warnings
 */

import { palette } from '../palette.js';

/**
 * Print each string in `warnings` to the console.
 *
 * - Strings that start with `[ERROR]` → `console.error(palette.error(w))`
 * - All others → `console.log(palette.warning(w))`
 *
 * A blank line is written before the list only when `warnings` is non-empty,
 * matching the existing convention in branch.ts and worktree.ts.
 *
 * @returns `true` when at least one warning starts with `[ERROR]`.
 */
export function printWarnings(warnings: readonly string[]): boolean {
  if (warnings.length === 0) return false;

  console.log('');
  for (const w of warnings) {
    if (w.startsWith('[ERROR]')) {
      console.error(palette.error(w));
    } else {
      console.log(palette.warning(w));
    }
  }

  return warnings.some((w) => w.startsWith('[ERROR]'));
}
