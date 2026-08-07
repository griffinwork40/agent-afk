/**
 * On-disk version resolution for the Telegram daemon's version-drift watchdog.
 *
 * Invariant: this MUST read package.json from disk on every call. It may NOT
 * use the esbuild `__AFK_VERSION__` define the way `src/cli/version.ts` does.
 * That define is baked into the bundle as a string literal, so it can never
 * change while the daemon runs — and drift detection compares the version the
 * daemon *started* at against the version currently installed on disk. A frozen
 * literal would make drift permanently undetectable in published installs,
 * which is precisely the case the watchdog exists to serve.
 *
 * Invariant: the candidate ladder is depth-agnostic because this module's own
 * location differs per build layout, and esbuild FLATTENS it into
 * `dist/telegram.mjs` — so `import.meta.url` does not track the source path:
 *
 *   1. bundled — `dist/telegram.mjs`               → `../package.json`    (package root)
 *   2. tsc     — `dist/telegram/daemon-version.js` → `../../package.json` (repo root)
 *   3. dev     — `src/telegram/daemon-version.ts`  → `../../package.json` (repo root)
 *
 * Order matters: `../package.json` is tried FIRST so the published bundle
 * resolves on its first candidate, byte-for-byte the path the pre-split
 * root-level `src/telegram.ts` used. Layouts 2 and 3 miss that candidate
 * (there is no `dist/package.json` or `src/package.json`) and fall through.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** Sentinel returned when no candidate yields a usable version string. */
export const UNKNOWN_VERSION = 'unknown';

/**
 * package.json locations relative to this module, in resolution order.
 * See the module docblock for why both depths are required.
 */
export const PACKAGE_JSON_CANDIDATES: readonly string[] = ['../package.json', '../../package.json'];

/**
 * Read the installed package version from disk.
 *
 * Returns {@link UNKNOWN_VERSION} when every candidate is missing, unreadable,
 * malformed, or carries no `version` string. Callers treat that as "drift
 * check disabled" — {@link checkVersionDrift} already short-circuits on it.
 *
 * `searchDir` and `readFile` are injectable test seams, mirroring
 * `resolveEntrypoint(searchDir, existsCheck)` in `manager.ts`.
 */
export function readDiskVersion(
  searchDir: string = dirname(fileURLToPath(import.meta.url)),
  readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, 'utf8'),
): string {
  for (const relative of PACKAGE_JSON_CANDIDATES) {
    try {
      const pkg = JSON.parse(readFile(join(searchDir, relative))) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // Missing / unreadable / malformed — try the next candidate.
    }
  }
  return UNKNOWN_VERSION;
}
