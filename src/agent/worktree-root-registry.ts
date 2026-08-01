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
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { getWorktreeRootsRegistryPath } from '../paths.js';
import { debugLog } from '../utils/debug.js';

/** Current on-disk schema version. Bump only on a breaking shape change. */
const REGISTRY_VERSION = 1;

/**
 * Upper bound on retained roots. A machine has a bounded number of active
 * repos; the cap stops a pathological writer from growing the file forever.
 * Oldest-seen entries are dropped first.
 */
const MAX_ROOTS = 64;

/**
 * The registry records the absolute path of every repo the user works in, so a
 * default umask would leave that list world-readable. `awareness/presence.ts`
 * treats the same data class as 0o600 for the same reason.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Ceiling on how long a write will wait for the cross-process lock before
 * giving up and writing anyway. Registration runs inside worktree creation, so
 * blocking a create is strictly worse than a rare lost update.
 */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_POLL_MS = 25;

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

// Invariant: every write to the registry file goes through `mutateRegistry`,
// and therefore through all three of the guards below, in this order:
//
//   1. `writeQueue` — an in-process promise chain. This is the guard that
//      matters most, because the reachable race is in-process: the tool
//      dispatcher runs agent forks concurrently, and every `isolation:
//      "worktree"` child calls registerWorktreeRoot() independently. Without
//      it, two forks read the same snapshot and the later write drops the
//      earlier one's root — and a dropped root is a root whose trees leak,
//      which is the very bug (#761) this module exists to fix.
//   2. an advisory lock file — covers the cross-process case (two afk
//      processes creating worktrees at once). Deliberately degradable: see
//      LOCK_TIMEOUT_MS. Never blocks a create.
//   3. temp-file + rename — makes a torn write impossible. A half-written
//      file parses as `[]`, which would silently discard every known root.
//
// The read-modify-write is re-read INSIDE the critical section; callers pass a
// pure transform, never a precomputed entry list, so nothing clobbers an entry
// that landed while they were deciding what to write.

let writeQueue: Promise<void> = Promise.resolve();

/** Chain `task` after any in-flight write. Never rejects, so the chain cannot break. */
function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(task, task).catch(() => undefined);
  writeQueue = next;
  return next;
}

/** Drop a lock whose owning process is gone (or whose pid is unreadable). */
async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const pid = Number.parseInt((await fs.readFile(lockPath, 'utf-8')).trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 0); // throws when the holder is gone
      return; // holder alive — leave it alone
    }
  } catch {
    /* unreadable pid, or holder dead → fall through and reclaim */
  }
  await fs.unlink(lockPath).catch(() => undefined);
}

/**
 * Best-effort cross-process lock. Resolves to a release fn, or `null` when the
 * lock could not be taken within {@link LOCK_TIMEOUT_MS} — in which case the
 * caller writes anyway. Returning `null` rather than throwing is the whole
 * point: bookkeeping must never fail or stall a worktree create.
 */
async function acquireRegistryLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', FILE_MODE);
      await handle.writeFile(String(process.pid), 'utf-8');
      await handle.close();
      return async () => { await fs.unlink(lockPath).catch(() => undefined); };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (Date.now() >= deadline) return null;
      await clearStaleLock(lockPath);
      await sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Replace the registry with `entries`, atomically.
 *
 * External constraint: `rename(2)` is atomic only within one filesystem, so the
 * temp file is written as a SIBLING of the target rather than in a tmpdir.
 */
async function writeRegistry(entries: RootEntry[]): Promise<void> {
  const target = getWorktreeRootsRegistryPath();
  await fs.mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  const payload: RegistryFile = { version: REGISTRY_VERSION, roots: entries };
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    // mode on the TEMP file, before the rename — writing the real path first
    // and chmod-ing after would leave a world-readable window.
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Apply `transform` to the current entries and persist the result. Never throws. */
async function mutateRegistry(transform: (entries: RootEntry[]) => RootEntry[]): Promise<void> {
  await enqueueWrite(async () => {
    const release = await acquireRegistryLock(`${getWorktreeRootsRegistryPath()}.lock`);
    try {
      await writeRegistry(transform(await readEntries()));
    } catch {
      /* best-effort — never fail a worktree create over bookkeeping */
    } finally {
      if (release !== null) await release();
    }
  });
}

/**
 * Enforce {@link MAX_ROOTS}, newest-last so the oldest-seen entries drop first.
 *
 * Eviction is reported because it is otherwise invisible: re-registering moves
 * an entry to the end, so a cold-but-live root holding worktrees can be pushed
 * past the cap by busier repos and then silently vanish from every future
 * sweep. A debug line makes that diagnosable instead of a mystery leak.
 */
function capRoots(entries: RootEntry[]): RootEntry[] {
  if (entries.length <= MAX_ROOTS) return entries;
  const evicted = entries.slice(0, entries.length - MAX_ROOTS);
  debugLog(
    `[worktree-root-registry] cap ${MAX_ROOTS} reached — evicting ${evicted.length} ` +
    `least-recently-seen root(s); their managed worktrees will no longer be swept: ` +
    evicted.map((e) => e.path).join(', '),
  );
  return entries.slice(-MAX_ROOTS);
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
  const now = new Date().toISOString();
  await mutateRegistry((entries) => {
    const others = entries.filter((e) => resolve(e.path) !== absolute);
    return capRoots([...others, { path: absolute, lastSeenAt: now }]);
  });
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
    // Self-heal, expressed as "drop exactly these dead paths" rather than
    // "overwrite with the list I just computed". The stat loop above is not
    // inside the lock, so a concurrent registerWorktreeRoot may have added a
    // root since; a wholesale overwrite would silently discard it.
    const dead = new Set(
      entries.map((e) => resolve(e.path)).filter((p) => !seen.has(p)),
    );
    await mutateRegistry((current) => {
      // Built fresh per invocation: a `kept` set closed over from outside would
      // already be full if the transform were ever applied a second time, and
      // would then drop every entry instead of de-duplicating them.
      const kept = new Set<string>();
      return current.flatMap((entry) => {
        const absolute = resolve(entry.path);
        if (dead.has(absolute) || kept.has(absolute)) return [];
        kept.add(absolute);
        return [{ ...entry, path: absolute }];
      });
    });
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
