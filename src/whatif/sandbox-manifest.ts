/**
 * Writes and formats the sandboxes.json manifest when --keep-sandboxes is set.
 *
 * The manifest lives in <runDir>/sandboxes.json — outside both arm roots so
 * neither arm can discover the other arm's root path by reading it.
 *
 * @module whatif/sandbox-manifest
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxManifest {
  baseline: string;
  candidate: string;
}

/** Return type for keepSandboxes: roots + where the mapping was written. */
export interface SandboxesKeptAt extends SandboxManifest {
  mappingPath: string;
}

// ---------------------------------------------------------------------------
// writeSandboxManifest
// ---------------------------------------------------------------------------

/**
 * Write `<runDir>/sandboxes.json` mapping each arm label to its sandbox root.
 *
 * @returns the absolute path of the written manifest file, or throws.
 */
export async function writeSandboxManifest(
  runDir: string,
  roots: SandboxManifest,
): Promise<string> {
  const manifestPath = path.join(runDir, 'sandboxes.json');
  const content = JSON.stringify(roots, null, 2) + '\n';
  await fsp.writeFile(manifestPath, content, 'utf8');
  return manifestPath;
}

// ---------------------------------------------------------------------------
// maybeWriteSandboxManifest
// ---------------------------------------------------------------------------

/**
 * Write sandboxes.json to runDir (best-effort) and return the sandboxesKeptAt
 * field to embed in the report. A write failure returns undefined so it never
 * masks the primary result.
 */
export async function maybeWriteSandboxManifest(
  runDir: string,
  roots: SandboxManifest,
): Promise<SandboxesKeptAt | undefined> {
  try {
    const mappingPath = await writeSandboxManifest(runDir, roots);
    return { ...roots, mappingPath };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// formatSandboxKeptMessage
// ---------------------------------------------------------------------------

/**
 * Format the one-line CLI message printed when sandboxes are kept.
 *
 * Example:
 *   Sandboxes kept — baseline: /tmp/afk-abc123  candidate: /tmp/afk-def456
 *   Mapping: /path/to/runDir/sandboxes.json
 */
export function formatSandboxKeptMessage(
  roots: SandboxManifest,
  manifestPath: string,
): string {
  return (
    `Sandboxes kept — baseline: ${roots.baseline}  candidate: ${roots.candidate}\n` +
    `Mapping: ${manifestPath}`
  );
}
