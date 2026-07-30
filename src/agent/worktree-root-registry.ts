/**
 * Registry of repo roots that contain afk-managed worktrees.
 *
 * Invariant: the sweep engine is PER-ROOT — it anchors on
 * `<repoRoot>/.afk-worktrees` and skips anything outside it. The daemon derived
 * that single root from its own cwd (or AFK_WORKTREE_SWEEP_ROOT), so managed
 * trees created under any OTHER repo were reachable by no sweep at all and
 * leaked permanently (#761). Recording each root at CREATE time is what lets a
 * later daemon tick reclaim every repo the user has actually worked in, not just
 * the one the daemon happens to sit in.
 *
 * Contract: every operation here is best-effort and never throws. Registration
 * runs inside worktree creation, and failing to record a root must never fail
 * the create — a missed entry degrades to the old single-root behaviour.
 *
 * Roots are pruned on read, not on a schedule: an entry whose directory no
 * longer exists (repo deleted or moved) is dropped, so the file cannot grow
 * without bound as scratch repos come and go.
 *
 * @module agent/worktree-root-registry
 */

import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getWorktreeRootsRegistryPath } from '../paths.js';

/** Current on-disk schema version. Bump only on a breaking shape change. */
const REGISTRY_VERSION = 1;

/**
 * Upper bound on retained roots. A machine has a bounded number of active
 * repos; the cap stops a pathological writer from growing the file forever.
 * Oldest-seen entries are dropped first.
 */
const MAX_ROOTS = 64;

interface RootEntry {
  path: string;
  lastSeenAt: string;
}

interface RegistryFile {
  version: number;
  roots: RootEntry[];
}

function parseRegistry(raw: string): RootEntry[] {
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    if (!Array.isArray(parsed.roots)) return [];
    return parsed.roots.filter(
      (e): e is RootEntry =>
        typeof e === 'object' && e !== null &&
        typeof (e as RootEntry).path === 'string' &&
        (e as RootEntry).path.length > 0,
    );
  } catch {
    return []; // unreadable/corrupt → start clean rather than throw
  }
}

async function readEntries(): Promise<RootEntry[]> {
  try {
    return parseRegistry(await fs.readFile(getWorktreeRootsRegistryPath(), 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Record `repoRoot` as containing managed worktrees. Idempotent: an existing
 * entry has its `lastSeenAt` refreshed rather than duplicated.
 *
 * Best-effort by contract — every failure is swallowed.
 */
export async function registerWorktreeRoot(repoRoot: string): Promise<void> {
  if (repoRoot === '') return;
  const absolute = resolve(repoRoot);
  try {
    const entries = await readEntries();
    const now = new Date().toISOString();
    const others = entries.filter((e) => resolve(e.path) !== absolute);
    // Newest last, so the oldest-seen entries are the ones the cap drops.
    const next = [...others, { path: absolute, lastSeenAt: now }].slice(-MAX_ROOTS);
    const payload: RegistryFile = { version: REGISTRY_VERSION, roots: next };
    const target = getWorktreeRootsRegistryPath();
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    /* best-effort — never fail a worktree create over bookkeeping */
  }
}

/**
 * Every registered root that still exists on disk, de-duplicated.
 *
 * Prunes vanished roots as a side effect so the file self-heals. Returns an
 * empty array on any failure, which makes callers fall back to their own
 * single-root resolution — i.e. exactly the pre-#761 behaviour.
 */
export async function readRegisteredWorktreeRoots(): Promise<string[]> {
  const entries = await readEntries();
  if (entries.length === 0) return [];

  const alive: RootEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const absolute = resolve(entry.path);
    if (seen.has(absolute)) continue;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isDirectory()) continue;
    } catch {
      continue; // gone → prune
    }
    seen.add(absolute);
    alive.push({ ...entry, path: absolute });
  }

  if (alive.length !== entries.length) {
    // Self-heal: rewrite without the vanished roots. Still best-effort.
    try {
      const payload: RegistryFile = { version: REGISTRY_VERSION, roots: alive };
      await fs.writeFile(
        getWorktreeRootsRegistryPath(),
        JSON.stringify(payload, null, 2),
        'utf-8',
      );
    } catch { /* ignore */ }
  }
  return alive.map((e) => e.path);
}

/**
 * The full set of roots one sweep pass should visit: `primary` (the caller's own
 * resolved root, or an explicit AFK_WORKTREE_SWEEP_ROOT) followed by every other
 * registered root, de-duplicated.
 *
 * `primary` comes FIRST so an explicitly targeted repo is always swept before
 * any discovered one, and is included even when absent from the registry — a
 * root the operator names explicitly must never depend on bookkeeping.
 */
export async function sweepRootSet(primary: string | null): Promise<string[]> {
  const registered = await readRegisteredWorktreeRoots();
  const ordered = primary !== null && primary !== '' ? [resolve(primary), ...registered] : registered;
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const root of ordered) {
    const absolute = resolve(root);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    roots.push(absolute);
  }
  return roots;
}
