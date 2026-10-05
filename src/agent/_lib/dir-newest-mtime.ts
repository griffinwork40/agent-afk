/**
 * Recursive "newest content mtime + total bytes" walk for retention sweeps.
 *
 * Shared by the witness sweep and the session-directory sweep.
 *
 * @module agent/_lib/dir-newest-mtime
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirStats { newestMtimeMs: number; bytes: number }

// Invariant: a directory's OWN mtime is not a usable liveness signal here.
// POSIX bumps a directory's mtime when an entry is created or unlinked, but NOT
// when an existing file inside it is appended to. A long-running session that
// creates no new files keeps appending to its JSONL (trace, ledger, journal)
// while its directory mtime stays frozen at creation time — so an mtime-only
// sweep would evict a LIVE session's data out from under it. Liveness must
// come from the newest mtime across the directory's CONTENTS, and callers
// additionally exclude the active session by identity so its survival never
// depends on this walk being right.
export async function newestMtimeAndBytes(dir: string): Promise<DirStats> {
  let newestMtimeMs = 0;
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      try {
        const st = await stat(child);
        bytes += st.size;
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
      } catch {
        /* raced away mid-walk — ignore */
      }
    }
  };
  await walk(dir);
  if (newestMtimeMs === 0) {
    // No files at all (empty or freshly-created dir). Fall back to the
    // directory's own mtime so an empty dir is not treated as epoch-old.
    try {
      newestMtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      newestMtimeMs = Date.now();
    }
  }
  return { newestMtimeMs, bytes };
}
