/**
 * Sandbox manifest writer for the what-if prediction engine.
 *
 * When `--keep-sandboxes` is set, writes a small JSON record that maps each
 * arm label to its temporary root directory.  The file is placed in the run
 * directory (alongside report.md and results.json) — intentionally OUTSIDE
 * either arm sandbox — so the operator can locate the kept sandboxes without
 * inspecting $TMPDIR themselves.
 *
 * The write is always best-effort: a failure is logged to stderr but never
 * masks the run's real result or error.
 *
 * @module whatif/sandbox-manifest
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Arm-to-root mapping recorded in <runDir>/sandboxes.json. */
export interface SandboxManifest {
  baseline: string;
  candidate: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write `<runDir>/sandboxes.json` containing the baseline and candidate arm
 * roots.  Returns the absolute path to the written file on success, or `null`
 * if the write fails (failure is logged, not thrown).
 *
 * Must only be called when `keepSandboxes` is true; the caller is responsible
 * for the guard.
 */
export async function writeSandboxManifest(
  runDir: string,
  roots: SandboxManifest,
): Promise<string | null> {
  const dest = path.join(runDir, 'sandboxes.json');
  try {
    await fsp.writeFile(dest, JSON.stringify(roots, null, 2) + '\n', 'utf8');
    return dest;
  } catch (err) {
    process.stderr.write(
      `[whatif] warning: could not write sandbox manifest to ${dest}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}
