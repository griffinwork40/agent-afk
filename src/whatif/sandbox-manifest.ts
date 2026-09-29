/**
 * sandbox-manifest.ts — record kept sandbox roots outside both sandboxes.
 *
 * When `--keep-sandboxes` is set, `run.ts` calls `writeSandboxManifest` to
 * write a JSON mapping of arm → root path into `<runDir>/sandboxes.json`.
 * The file lives in the run dir, which is NOT reachable from either arm's
 * home, so this does not reopen the blinding leak fixed in #2466.
 *
 * The companion `formatKeptSandboxes` helper produces the human-readable
 * CLI line that follows the "Full report:" output.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Shape written to `<runDir>/sandboxes.json`. */
export interface SandboxManifest {
  baseline: string;
  candidate: string;
}

/**
 * Write `<runDir>/sandboxes.json` with the arm-to-root mapping.
 * Returns the absolute path of the written file.
 */
export async function writeSandboxManifest(
  runDir: string,
  roots: SandboxManifest,
): Promise<string> {
  const manifestPath = path.join(runDir, 'sandboxes.json');
  await fsp.writeFile(manifestPath, JSON.stringify(roots, null, 2) + '\n', 'utf8');
  return manifestPath;
}

/**
 * Format the kept-sandboxes notice for CLI output.
 * Returns an empty string when `keptSandboxes` is absent (keepSandboxes=false).
 */
export function formatKeptSandboxes(
  runDir: string,
  keptSandboxes: SandboxManifest | undefined,
): string {
  if (!keptSandboxes) return '';
  return (
    `Sandboxes kept: baseline=${keptSandboxes.baseline}` +
    ` candidate=${keptSandboxes.candidate}` +
    ` (mapping: ${path.join(runDir, 'sandboxes.json')})`
  );
}
