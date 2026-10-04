import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const UNKNOWN_VERSION = 'unknown';

// Invariant: esbuild flattens this module into dist/cli.mjs or
// dist/telegram.mjs. Try the bundle depth first, then src/utils or dist/utils.
export const PACKAGE_JSON_CANDIDATES: readonly string[] = ['../package.json', '../../package.json'];

/** Read fresh disk state, never the frozen esbuild version literal. */
export function readDiskVersion(
  searchDir: string = dirname(fileURLToPath(import.meta.url)),
  readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, 'utf8'),
): string {
  for (const relative of PACKAGE_JSON_CANDIDATES) {
    try {
      const pkg = JSON.parse(readFile(join(searchDir, relative))) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // Missing, unreadable, or malformed: try the next candidate.
    }
  }
  return UNKNOWN_VERSION;
}

export interface VersionDriftResult {
  drift: boolean;
  message?: string;
}

/** Unknown versions disable drift detection. Preserve the daemon log contract. */
export function checkVersionDrift(
  spawnedVersion: string,
  diskVersion: string,
): VersionDriftResult {
  if (!spawnedVersion || !diskVersion || spawnedVersion === UNKNOWN_VERSION || diskVersion === UNKNOWN_VERSION) {
    return { drift: false };
  }
  if (spawnedVersion === diskVersion) return { drift: false };
  return {
    drift: true,
    message: `[daemon] Version mismatch: running ${spawnedVersion} but installed is ${diskVersion}. Exiting.`,
  };
}
