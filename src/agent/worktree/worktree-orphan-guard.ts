/**
 * Removal gate for UNREGISTERED directories under `.afk-worktrees/`.
 *
 * Invariant: the sweep's orphan path has no git information to work with. The
 * directory is absent from `git worktree list`, so `git status --porcelain` —
 * the sweep's only dirty signal — cannot classify it, and every protection the
 * registered-candidate path applies (dirty check, ignored-file probe, age gate)
 * is unreachable there. This module is the substitute floor: it decides from the
 * filesystem alone, and every uncertain answer preserves.
 *
 * Contract: `classifyOrphanDir` never deletes and never throws. It returns
 * `{ remove: true }` only for a directory that is BOTH older than the caller's
 * minimum age AND provably free of content a rebuild would not restore. Anything
 * else — a fresh directory, an unreadable one, a scan that outgrows its budget,
 * or a single unrecognised entry — yields `{ remove: false }` with a reason the
 * caller can print.
 *
 * The asymmetry is deliberate: preserving a dead orphan costs one leaked
 * directory, reclaimed when it ages out or is removed explicitly. Deleting a
 * live one destroys uncommitted work and `.env` files with no recovery path,
 * because an unregistered directory has no branch ref holding its contents
 * (#794, following #759).
 *
 * @module agent/worktree-orphan-guard
 */

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { classifyIgnoredEntry } from './worktree-ignored-patterns.js';

/**
 * Contract: `classifyIgnoredEntry` is the shared policy and it defaults an
 * unrecognised path to `'protected'`. That default is what makes this walk
 * correct for a directory git never classified at all: an ordinary source file
 * is as protective as a stray secret, so only recognisably rebuildable output
 * can clear the way for a delete. Depending on the pure policy module (rather
 * than the probe's boolean wrapper) keeps this module free of git IO.
 */
function isRebuildable(relPath: string): boolean {
  return classifyIgnoredEntry(relPath) !== 'protected';
}

/**
 * True when `entry` names a directory, resolving symlinks the way the ignored
 * probe does.
 *
 * Invariant: `Dirent.isDirectory()` is false for a SYMLINK regardless of its
 * target, because `readdir` does not follow links. A symlinked `node_modules`
 * — the standard way a worktree avoids a duplicate install — therefore fell to
 * the file branch, matched no directory pattern (all of which require a
 * trailing slash), and classified `protected`, pinning the orphan on disk
 * forever. The probe already resolves this case via `stat`; mirroring it here
 * keeps the two production consumers of the shared policy from disagreeing on
 * an identical on-disk layout.
 *
 * Fail-safe direction is unchanged: a broken link, a race, or a permission
 * error throws and answers `false`, which routes the entry to the file branch
 * where an unrecognised name still protects the tree.
 */
async function resolvesToDirectory(entry: Dirent, fullPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

/** Why an orphaned directory must be left on disk. */
export type OrphanPreserveReason =
  /** Younger than the age gate — very likely an in-flight `git worktree add`. */
  | 'too-young'
  /** Holds at least one entry a rebuild would not restore. */
  | 'non-rebuildable-content'
  /** The directory could not be read, so its contents are unknown. */
  | 'scan-failed'
  /** The walk outgrew its bounds before it could prove the tree disposable. */
  | 'scan-budget-exhausted';

/** Fate of one unregistered directory under `.afk-worktrees/`. */
export type OrphanVerdict =
  | { remove: true }
  | { remove: false; because: OrphanPreserveReason; detail?: string };

/**
 * Walk bounds. A failed `worktree add` can still have left a full
 * `node_modules/` behind, so the walk must not be free to enumerate it — but
 * rebuildable directories are skipped WHOLESALE (never descended into), which
 * keeps the real cost proportional to hand-authored content rather than to
 * dependency-tree size.
 */
export const ORPHAN_SCAN_MAX_DEPTH = 8;
export const ORPHAN_SCAN_MAX_ENTRIES = 4_000;

/**
 * Decide whether an unregistered `.afk-worktrees/` directory may be removed.
 *
 * @param orphanPath  Absolute path to the directory.
 * @param orphanAgeMs Age from directory birthtime. A caller that could not stat
 *                    the directory must pass `0`, which preserves via the age
 *                    gate rather than reading as "infinitely old".
 * @param minAgeMs    Minimum age before removal is considered at all.
 */
export async function classifyOrphanDir(
  orphanPath: string,
  orphanAgeMs: number,
  minAgeMs: number,
  limits: { maxDepth?: number; maxEntries?: number } = {},
): Promise<OrphanVerdict> {
  // Age gate first: it is the cheapest check and the one that covers the most
  // likely cause of an orphan, a `git worktree add` still in flight.
  if (!Number.isFinite(orphanAgeMs) || orphanAgeMs < minAgeMs) {
    return {
      remove: false,
      because: 'too-young',
      detail: `age ${Math.max(0, Math.round(orphanAgeMs))}ms < ${minAgeMs}ms`,
    };
  }

  const maxDepth = limits.maxDepth ?? ORPHAN_SCAN_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? ORPHAN_SCAN_MAX_ENTRIES;

  let remaining = maxEntries;
  const pending: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: orphanPath, rel: '', depth: 0 },
  ];

  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch (err) {
      return {
        remove: false,
        because: 'scan-failed',
        detail: `${dir.rel === '' ? orphanPath : dir.rel}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    for (const entry of entries) {
      if (--remaining < 0) {
        return {
          remove: false,
          because: 'scan-budget-exhausted',
          detail: `exceeded ${maxEntries} entries`,
        };
      }

      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`;
      const fullPath = join(dir.abs, entry.name);
      const isDirLike = await resolvesToDirectory(entry, fullPath);

      // Invariant: a SYMLINKED directory is classified but never descended
      // into. Removing the orphan unlinks the symlink and never traverses it,
      // so its target's contents are not at risk and walking them would only
      // duplicate work already owned by another tree — or cycle, if the link
      // points at an ancestor. Classifying it is still required: an opaque
      // symlinked `node_modules` must clear the way for reclamation instead of
      // falling to the file branch and protecting the orphan forever.
      if (isDirLike && !entry.isDirectory()) {
        if (classifyIgnoredEntry(`${rel}/`) === 'opaque') continue;
        return { remove: false, because: 'non-rebuildable-content', detail: rel };
      }

      if (entry.isDirectory()) {
        // Invariant: only an `opaque` directory may be skipped wholesale. The
        // shared policy separates dependency trees (`opaque` — enormous, and
        // machine-owned, so descending costs more than it can ever find) from
        // build output (`inspectable` — small, and demonstrably able to hide
        // local state: `dist/prod.env` is the #759 case). Skipping both would
        // reproduce that bug on the orphan path. Anything unrecognised is
        // descended into as well, so the preserve reason can name the real file
        // rather than the directory, and an empty unrecognised directory does
        // not block reclamation.
        // Trailing slash: the patterns are written against git's `--ignored`
        // output, where a directory always ends in `/`.
        if (classifyIgnoredEntry(`${rel}/`) === 'opaque') continue;
        if (dir.depth + 1 > maxDepth) {
          return { remove: false, because: 'scan-failed', detail: `depth limit at ${rel}` };
        }
        pending.push({ abs: fullPath, rel, depth: dir.depth + 1 });
        continue;
      }

      // Files, symlinks, sockets — anything not a directory. An entry that is
      // not recognisably rebuildable output protects the tree, which is also
      // how an ordinary source file or a stray secret is caught: the shared
      // policy defaults unrecognised paths to 'protected'.
      if (!isRebuildable(rel)) {
        return { remove: false, because: 'non-rebuildable-content', detail: rel };
      }
    }
  }

  return { remove: true };
}
