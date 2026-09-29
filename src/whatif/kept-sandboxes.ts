/**
 * Helper for recording kept sandbox roots when --keep-sandboxes is set.
 *
 * When keepSandboxes is true, we skip cleanup() but we need to tell the user
 * where the sandboxes are.  We write a JSON mapping file to the run dir
 * (outside either sandbox root) so it survives independently of the sandboxes.
 *
 * @module whatif/kept-sandboxes
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface KeptSandboxes {
  baseline: string;
  candidate: string;
}

/**
 * When keepSandboxes is true: write `<runDir>/sandboxes.json` with the arm
 * roots and return the mapping.  When keepSandboxes is false: run cleanup and
 * return undefined.
 *
 * The mapping file is intentionally placed in `runDir`, which is NOT reachable
 * from inside either sandbox (they live under os.tmpdir() with no reference
 * back to runDir).  This does not reopen issue #2466.
 */
export async function cleanupOrRecord(
  runDir: string,
  roots: KeptSandboxes,
  cleanup: () => Promise<void>,
  keepSandboxes: boolean,
): Promise<KeptSandboxes | undefined> {
  if (!keepSandboxes) {
    await cleanup().catch(() => {
      // Best-effort; do not mask the primary error
    });
    return undefined;
  }

  // Write the mapping outside either sandbox root.
  // Best-effort: this runs in a `finally`, so a write failure must not mask
  // the run's primary result or error. The roots are still returned so the
  // CLI can print them.
  const mappingPath = path.join(runDir, 'sandboxes.json');
  await fsp
    .writeFile(mappingPath, JSON.stringify(roots, null, 2) + '\n', 'utf8')
    .catch(() => {});
  return roots;
}
