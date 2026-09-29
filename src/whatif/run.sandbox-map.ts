/**
 * Write the kept-sandbox mapping to the run directory.
 *
 * When `--keep-sandboxes` is set, each arm's root is an opaque
 * `$TMPDIR/afk-XXXXXX` directory.  Nothing in the run dir points to
 * them, so the operator would have to guess where they are.
 *
 * This module writes `<runDir>/sandboxes.json` with the baseline and
 * candidate roots so the operator can find and inspect them.  The file
 * lives outside both sandbox roots (required: writing inside either root
 * would reopen the #2466 blinding leak).
 *
 * @module whatif/run.sandbox-map
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SandboxMap {
  baseline: string;
  candidate: string;
}

/** Filename written in the run dir. */
export const SANDBOX_MAP_FILENAME = 'sandboxes.json';

/**
 * Write `<runDir>/sandboxes.json` with the arm-to-root mapping.
 *
 * Best-effort: errors are swallowed so a write failure never masks the
 * primary run result.  Returns the path written on success, or null on
 * failure.
 *
 * Safety: `runDir` must not be inside either sandbox root — callers must
 * ensure this (it is guaranteed by the run.ts architecture because runDir
 * is created from `getWhatifDir()`, which is always outside os.tmpdir()).
 */
export function writeSandboxMap(runDir: string, roots: SandboxMap): string | null {
  const outPath = join(runDir, SANDBOX_MAP_FILENAME);
  try {
    writeFileSync(outPath, JSON.stringify(roots, null, 2) + '\n', 'utf8');
    return outPath;
  } catch {
    return null;
  }
}
