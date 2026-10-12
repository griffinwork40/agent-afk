/**
 * Shared error-reporting helper for the `afk config` command tree.
 *
 * Extracted from {@link registerConfigCommand} and {@link registerEnvSubcommands}
 * to avoid duplicating the same one-liner in two sibling modules.
 *
 * @module cli/commands/config-command.fail
 */

import { palette } from '../palette.js';

/** Print an error and set a nonzero exit code (2 = bad input / refused). */
export function fail(message: string): void {
  console.error(palette.warning(`✗ ${message}`));
  process.exitCode = 2;
}
