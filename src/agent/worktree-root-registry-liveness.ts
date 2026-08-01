/**
 * Liveness classification for the worktree root registry's prune-on-read.
 *
 * Split out of worktree-root-registry.ts (which stays under the repo's
 * 350-LOC ceiling) to hold the stat()-based tri-state classification and its
 * debug logging. Pure with respect to the registry file itself — this module
 * never reads or writes worktree-roots.json; the caller (registry.ts) decides
 * what to persist from the `dead` set this returns.
 *
 * Contract: a `stat` rejection is CONFIRMED DEAD only for `ENOENT` /
 * `ENOTDIR`, or when it resolves but the target is not a directory — those
 * are safe to prune, matching the registry's pre-#771-followup behaviour. Any
 * OTHER errno (`EACCES`, `EIO`, `ESTALE` — an unmounted volume, an ancestor
 * that lost `+x`) is UNKNOWN: the entry is excluded from `alive` for this pass
 * but is NEVER added to `dead`, so the caller keeps it in the on-disk file for
 * a retry on the next read. Treating every rejection as "gone" let one
 * transient permission error permanently drop a live root with no recovery
 * path short of registering a brand-new worktree in that repo — recreating
 * the exact #761 leak this registry exists to close.
 *
 * @module agent/worktree-root-registry-liveness
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { debugLog } from '../utils/debug.js';

export interface RootLivenessResult<T> {
  /** Confirmed-live entries, `path` normalized to absolute and de-duplicated. */
  alive: T[];
  /** Confirmed-dead absolute paths — safe to drop from the registry file. */
  dead: Set<string>;
}

/**
 * Classify each entry's `path` as confirmed-live, confirmed-dead, or unknown.
 * Never throws — every per-entry stat error is caught and folded into a class.
 */
export async function classifyRootLiveness<T extends { path: string }>(
  entries: readonly T[],
): Promise<RootLivenessResult<T>> {
  const alive: T[] = [];
  const dead = new Set<string>();
  const deadPaths: string[] = [];
  const unknownPaths: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const absolute = resolve(entry.path);
    if (seen.has(absolute)) continue;

    let isDir: boolean;
    try {
      isDir = (await fs.stat(absolute)).isDirectory();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown errno';
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        dead.add(absolute);
        deadPaths.push(absolute);
      } else {
        unknownPaths.push(`${absolute} (${code})`);
      }
      continue;
    }

    if (!isDir) {
      dead.add(absolute);
      deadPaths.push(absolute);
      continue;
    }

    seen.add(absolute);
    alive.push({ ...entry, path: absolute });
  }

  // Mirrors capRoots' style in the registry module: one aggregated debug line
  // per class rather than one per entry, naming every affected path so a
  // pruned or stuck-unknown root is diagnosable instead of a silent mystery.
  if (deadPaths.length > 0) {
    debugLog(
      `[worktree-root-registry] pruning ${deadPaths.length} dead root(s) — gone or no ` +
      `longer a directory: ${deadPaths.join(', ')}`,
    );
  }
  if (unknownPaths.length > 0) {
    debugLog(
      `[worktree-root-registry] retaining ${unknownPaths.length} root(s) with an unreadable ` +
      `liveness check this pass (kept in the file, excluded from this pass' results): ` +
      unknownPaths.join(', '),
    );
  }

  return { alive, dead };
}
