/**
 * Canonical identity for a worktree-sweep repo root.
 *
 * Invariant: two strings naming the SAME repo must normalize to one value, or
 * the registry stores that repo twice — and a duplicate is not merely untidy:
 * the daemon sweeps the same root twice per tick, the root earns two
 * soft-launch valve credits instead of one, and both entries count against
 * `MAX_ROOTS`, so duplicates can evict a live root from the registry entirely.
 * `resolve()` alone is not enough for that job. It collapses `.`/`..` and a
 * trailing separator but leaves two real divergences intact: a symlinked
 * ancestor (`/var/folders/...` vs `/private/var/folders/...` on macOS, or any
 * developer who reaches a repo through a symlinked parent) and a case variant
 * on a case-insensitive filesystem (APFS, HFS+, NTFS). `realpath` resolves
 * both — it returns the on-disk canonical casing for every existing component.
 *
 * Contract: falls back to `resolve()` when `realpath` fails. A path that does
 * not exist yet has no canonical form, and this helper is on the best-effort
 * registration path, so it must never throw.
 *
 * Kept in its own module rather than imported from `worktree-sweep.ts` (which
 * has a sync `realpathSafe` for candidate containment) so the registry does not
 * take a dependency on the sweep engine — that direction would be a cycle.
 *
 * @module agent/worktree-root-path
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

/** Absolute, symlink- and case-canonical form of `root`. Never throws. */
export async function normalizeRootPath(root: string): Promise<string> {
  const absolute = resolve(root);
  try {
    return await fs.realpath(absolute);
  } catch {
    return absolute;
  }
}
