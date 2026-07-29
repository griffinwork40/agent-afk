/**
 * Drain for warnings buffered during `bootstrapSession` (#745).
 *
 * Extracted so the REPL's two mutually exclusive exits out of bootstrap — the
 * post-clear pre-arm block on success, and the `catch` that precedes
 * `handleCommandError` on abort — print through one code path instead of two
 * copies that can drift.
 *
 * @module cli/commands/interactive/boot-warnings
 */

import { palette } from '../../palette.js';

/**
 * Print every buffered bootstrap warning, then empty the buffer in place.
 *
 * Contract: emptying is unconditional and MUTATES the caller's array. That is
 * what makes a second call a no-op rather than a double-print, so neither exit
 * path needs to know whether the other already ran. A no-op on an empty buffer,
 * so callers need no length guard.
 *
 * Writes via `console.warn` (stderr) deliberately: the success-path caller runs
 * inside a block that counts newlines on both streams to derive
 * `preArmAnchorRow`, so these lines must pass through a wrapped stream write.
 */
export function drainBootWarnings(warnings: string[]): void {
  for (const w of warnings) {
    console.warn(palette.warning(`  ${w}`));
  }
  warnings.length = 0;
}
