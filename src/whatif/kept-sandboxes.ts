/**
 * Helper for recording kept-sandbox roots when --keep-sandboxes is set.
 *
 * Writes a `sandboxes.json` file into the run directory (which is outside
 * both arm roots, so this does NOT reopen issue #2466).  Writing into the
 * sandbox itself is prohibited — the mapping must never be reachable from
 * either arm's AFK_HOME.
 *
 * @module whatif/kept-sandboxes
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface KeptSandboxRoots {
  baseline: string;
  candidate: string;
}

/**
 * Write `<runDir>/sandboxes.json` with the arm-to-root mapping and return
 * the mapping.  Failures are swallowed so they never mask a real run error.
 */
export async function recordKeptSandboxes(
  runDir: string,
  roots: KeptSandboxRoots,
): Promise<KeptSandboxRoots> {
  const dest = path.join(runDir, 'sandboxes.json');
  try {
    await fsp.writeFile(dest, JSON.stringify(roots, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort; do not mask the primary result.
  }
  return roots;
}
