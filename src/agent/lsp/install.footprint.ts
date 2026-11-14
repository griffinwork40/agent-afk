/**
 * Disk-footprint reporter for AFK-managed LSP server installs (#4272).
 *
 * `getLspInstallFootprint()` returns the bytes consumed by each language's
 * install directory under `getLspServersDir()`. Used by `afk doctor` (wired
 * separately) and a future size-cap enforcement pass.
 *
 * @module agent/lsp/install.footprint
 */

import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { getLspServersDir } from '../../paths.lsp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-language byte count under the AFK LSP cache dir. */
export interface LspLanguageFootprint {
  readonly language: string;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bounded-concurrency queue cap for directory traversal.
 * Prevents unbounded Promise.all fan-out on deep node_modules trees.
 */
const DIR_BYTES_CONCURRENCY = 32;

/** Recursively sum byte sizes under `dir`. Returns 0 on any error. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    if (!(await lstat(dir)).isDirectory()) return 0;
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  // Bounded concurrency: cap simultaneous stat/readdir calls to avoid
  // opening thousands of file descriptors on deep node_modules trees.
  let index = 0;
  async function worker(): Promise<void> {
    while (index < entries.length) {
      const name = entries[index++];
      if (name === undefined) break;
      const child = join(dir, name);
      try {
        const st = await lstat(child);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          total += await dirBytes(child);
        } else if (!st.isDirectory()) {
          total += st.size;
        }
      } catch {
        // Ignore permission / race errors.
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(DIR_BYTES_CONCURRENCY, entries.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the disk footprint of every language installed under
 * `getLspServersDir()`.
 *
 * Only directories directly under the servers root are counted (each
 * directory is one language key). Errors reading individual language dirs are
 * swallowed so a broken install does not prevent reporting the healthy ones.
 *
 * @param serversDir - Override for tests; defaults to `getLspServersDir()`.
 */
export async function getLspInstallFootprint(
  serversDir?: string,
): Promise<LspLanguageFootprint[]> {
  const root = serversDir ?? getLspServersDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (name): Promise<LspLanguageFootprint> => {
      const bytes = await dirBytes(join(root, name));
      return { language: name, bytes };
    }),
  );

  return results.sort((a, b) => a.language.localeCompare(b.language));
}
