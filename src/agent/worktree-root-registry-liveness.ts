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
  /**
   * True when two or more raw entries resolved to the same absolute path (e.g.
   * one stored with a trailing slash). Reported separately because it is the
   * caller's OTHER reason to rewrite the file: `alive.length !== entries.length`
   * cannot stand in for it, since that also goes true whenever an entry lands
   * in the retained-unknown class, which must NOT trigger a rewrite.
   */
  duplicates: boolean;
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
  // Invariant: path → errno, keyed so a duplicate absolute path (e.g. one
  // registry entry stored with a trailing slash) reports once instead of
  // once per raw entry. A `Map` rather than a `Set<string>` because the
  // debug line still needs the per-path errno, not just the path.
  const unknown = new Map<string, string>();
  const seen = new Set<string>();

  for (const entry of entries) {
    const absolute = resolve(entry.path);
    // Invariant: marking `seen` here — BEFORE the stat — is what makes each
    // unique absolute path classified exactly once. Marking it only on the
    // confirmed-live branch (as a prior version of this function did) let a
    // second entry resolving to the same path re-stat after the first one
    // failed ENOENT: the path landed in `dead` from the first pass and in
    // `alive` from the second, and the caller in registry.ts both returns it
    // as a sweepable root AND deletes it from the registry file — silently
    // unregistering a live root (the #761 leak this registry exists to close).
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    let isDir: boolean;
    try {
      isDir = (await fs.stat(absolute)).isDirectory();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown errno';
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        dead.add(absolute);
      } else {
        unknown.set(absolute, code);
      }
      continue;
    }

    if (!isDir) {
      dead.add(absolute);
      continue;
    }

    alive.push({ ...entry, path: absolute });
  }

  // Mirrors capRoots' style in the registry module: one aggregated debug line
  // per class rather than one per entry, naming every affected path so a
  // pruned or stuck-unknown root is diagnosable instead of a silent mystery.
  // Derived from `dead`/`unknown` themselves (rather than parallel arrays
  // pushed to inside the loop above) so a path can never be double-counted.
  if (dead.size > 0) {
    debugLog(
      `[worktree-root-registry] pruning ${dead.size} dead root(s) — gone or no ` +
      `longer a directory: ${Array.from(dead).join(', ')}`,
    );
  }
  if (unknown.size > 0) {
    const rendered = Array.from(unknown, ([path, code]) => `${path} (${code})`).join(', ');
    debugLog(
      `[worktree-root-registry] retaining ${unknown.size} root(s) with an unreadable ` +
      `liveness check this pass (kept in the file, excluded from this pass' results): ` +
      rendered,
    );
  }

  // `seen` holds one entry per UNIQUE absolute path (it is marked before the
  // stat, above), so a shortfall against the raw entry count is exactly the
  // duplicate case — independent of how many entries were dead or unknown.
  return { alive, dead, duplicates: seen.size !== entries.length };
}
