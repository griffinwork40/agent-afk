/**
 * Ripgrep-binary availability check.
 *
 * `@vscode/ripgrep`'s `rgPath` resolves the platform-specific `rg` binary
 * through an optional-dependency package (e.g. `@vscode/ripgrep-linux-x64`).
 * When that optional dependency didn't install — a skipped
 * `pnpm.onlyBuiltDependencies` entry, an arch/platform mismatch, or a
 * corrupted `node_modules` — `rgPath` still resolves to a *string*, but the
 * file it points at is missing or not executable. Spawning it then surfaces
 * as a bare `spawn <rgPath> ENOENT` — an error shape indistinguishable, by
 * the error object alone, from the dead-cwd masquerade `describeSpawnCwdError`
 * already handles (#441).
 *
 * This module translates that failure AFTER it happens: `accessSync` runs
 * only on the error path, so there is no TOCTOU window, no happy-path cost,
 * and no pre-spawn contract change. The grep handler checks this FIRST in
 * its `error` listener — ahead of the cwd-diagnosis branch — so a bad
 * `rgPath` is diagnosed as "ripgrep binary is missing/not executable", never
 * misattributed to a deleted worktree.
 *
 * @module agent/tools/handlers/_rg-availability
 */

import { accessSync, constants } from 'node:fs';

/**
 * Return a distinguishing, actionable message when `rgPath` does not exist
 * or is not executable; otherwise return `undefined`.
 *
 * Contract: pure translation — never throws (a thrown `accessSync` error is
 * caught and turned into the returned message), and only touches the
 * filesystem when called. Call only on the error path (mirrors
 * {@link describeSpawnCwdError} in `spawn-cwd-error.ts`).
 */
export function describeRgUnavailable(rgPath: string): string | undefined {
  try {
    accessSync(rgPath, constants.X_OK);
    return undefined;
  } catch (err) {
    const underlying = err instanceof Error ? err.message : String(err);
    return (
      `ripgrep binary is missing or not executable: ${rgPath} ` +
      `(a platform optional-dependency for @vscode/ripgrep may not have ` +
      `installed — check pnpm.onlyBuiltDependencies) — underlying: ${underlying}`
    );
  }
}
