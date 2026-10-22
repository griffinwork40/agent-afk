/**
 * Disk-footprint reporter for AFK-managed LSP server installs (#4272).
 *
 * `getLspInstallFootprint()` returns the bytes consumed by each language's
 * install directory under `getLspServersDir()`. Used by `afk doctor` (wired
 * separately) and a future size-cap enforcement pass.
 *
 * @module agent/lsp/install.footprint
 */

import { readdir, stat } from 'node:fs/promises';
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

/** Recursively sum byte sizes under `dir`. Returns 0 on any error. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  await Promise.all(
    entries.map(async (name) => {
      const child = join(dir, name);
      try {
        const st = await stat(child);
        if (st.isDirectory()) {
          total += await dirBytes(child);
        } else {
          total += st.size;
        }
      } catch {
        // Ignore permission / race errors.
      }
    }),
  );
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
