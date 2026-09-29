/**
 * Helper for recording kept sandbox roots outside both arm directories.
 *
 * When --keep-sandboxes is set, we write a `sandboxes.json` file in the
 * run directory (not inside either arm's root) so the operator can find
 * the anonymous $TMPDIR/afk-XXXXXX directories left behind.
 *
 * This is deliberately a separate module to keep run.ts within the
 * 350-code-line ceiling.
 *
 * @module whatif/run.sandboxes
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface KeptSandboxRoots {
  baseline: string;
  candidate: string;
}

/**
 * Write `<runDir>/sandboxes.json` with the arm-to-root mapping and return
 * the mapping so it can be attached to the WhatifReport.
 *
 * NEVER writes into either arm's root — runDir is guaranteed to be outside
 * both arm roots (they live under os.tmpdir() via mkdtemp; runDir is under
 * the whatif state directory).
 *
 * A write failure is logged but does not propagate — the caller wraps this
 * in a best-effort try/catch so a disk error doesn't mask the primary result.
 */
export async function recordKeptSandboxes(
  runDir: string,
  roots: KeptSandboxRoots,
): Promise<KeptSandboxRoots> {
  const jsonPath = path.join(runDir, 'sandboxes.json');
  const payload = JSON.stringify(roots, null, 2) + '\n';
  await fsp.writeFile(jsonPath, payload, 'utf8');
  return roots;
}
