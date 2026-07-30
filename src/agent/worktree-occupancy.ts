/**
 * Worktree occupancy touch — keeps the sweep engine's liveness signals
 * accurate for worktrees occupied by forked subagents.
 *
 * Presence files are top-level-only (`src/agent/awareness/presence.ts`):
 * a subagent dispatched with a `cwd` inside a worktree never writes one, so
 * the sweep's live-session guard cannot see the occupation. Without a
 * countervailing signal, a clean worktree hosting a long investigation can
 * cross the `empty`/`stale-clean` age thresholds and be judged reapable
 * while a subagent is still working in it.
 *
 * `touchWorktreeOccupancy` closes most of that gap: at dispatch time it
 * rewrites the worktree's `.afk-worktree-meta.json` with the current pid and
 * a fresh `createdAt`. Effects on the sweep (`worktree-sweep.ts`):
 *   - `ageMs` resets (meta.createdAt is preferred over dir birthtime), so
 *     all age-gated verdicts (`empty`, `stale-clean`, `stale-dirty`) re-arm.
 *   - `ownerLiveness` resolves to 'alive' while this process runs, which
 *     suppresses the accelerated `dead-owner` path.
 *
 * A single touch only buys MIN_EMPTY_AGE_MS (1h) of protection, so a child that
 * outlives it in a clean tree used to age back across the `empty` threshold and
 * get reaped mid-run (#759). `startWorktreeOccupancyHeartbeat` closes that by
 * re-asserting the occupation for as long as the child runs.
 *
 * The `worktree` tool's `keep` action (git worktree lock) remains the sanctioned
 * escape hatch for anything that must survive unconditionally, including across
 * process exit.
 *
 * Best-effort by contract: every failure is swallowed. A missed touch
 * degrades to today's behavior; it must never block or fail a dispatch.
 *
 * @module agent/worktree-occupancy
 */

import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const META_FILENAME = '.afk-worktree-meta.json';
const AFK_WORKTREES_SEGMENT = `${sep}.afk-worktrees${sep}`;

/**
 * Heartbeat period. Must stay comfortably below the sweep's MIN_EMPTY_AGE_MS
 * (1h, `worktree-sweep.ts`) so a tick always lands before the age gate re-arms.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 600_000; // 10 minutes

/**
 * Resolve the worktree root containing `cwd`, when `cwd` sits inside an
 * `.afk-worktrees/` tree. Returns undefined otherwise.
 *
 * Pure path computation — no filesystem access.
 */
export function worktreeRootFor(cwd: string): string | undefined {
  const abs = resolve(cwd);
  const idx = abs.indexOf(AFK_WORKTREES_SEGMENT);
  if (idx === -1) return undefined;
  const afterRoot = abs.slice(idx + AFK_WORKTREES_SEGMENT.length);
  const slug = afterRoot.split(sep)[0];
  if (!slug) return undefined;
  return abs.slice(0, idx + AFK_WORKTREES_SEGMENT.length) + slug;
}

/**
 * Stamp the worktree containing `cwd` as occupied by this process.
 *
 * Rewrites `pid` and `createdAt` in the tree's meta file, preserving any
 * other fields (owner, baseSha, baseBranch). Creates a minimal meta when
 * none exists (owner 'agent') — this is exactly the case of a bash-created
 * ghost worktree being adopted by a subagent dispatch.
 *
 * No-op (silently) when `cwd` is not inside an `.afk-worktrees/` tree or on
 * any filesystem error.
 */
export async function touchWorktreeOccupancy(cwd: string): Promise<void> {
  const root = worktreeRootFor(cwd);
  if (root === undefined) return;
  const metaPath = join(root, META_FILENAME);
  try {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      meta = { owner: 'agent' };
    }
    meta['pid'] = process.pid;
    meta['createdAt'] = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    /* best-effort — never block dispatch */
  }
}

/**
 * Keep the worktree containing `cwd` marked as occupied for as long as the
 * caller runs, returning the function that stops it.
 *
 * Invariant: the sweep derives `ageMs` from `meta.createdAt`, so ONE touch at
 * dispatch protects a child for only MIN_EMPTY_AGE_MS. A longer-running child
 * ages back into the `empty` verdict and is force-removed mid-flight (#759).
 * Occupation must therefore be re-asserted periodically, not stamped once.
 *
 * Ordering constraint (governed by the Node event loop, not by this module):
 * `stop` is defined and captured BEFORE the interval is armed, so there is no
 * window in which a timer exists without a handle able to cancel it. The timer
 * is `unref()`d so a pending heartbeat can never hold the process open past the
 * work it was protecting.
 *
 * Callers MUST call the returned function from a `finally`, so it runs on normal
 * return, on throw, and on abort alike.
 */
export function startWorktreeOccupancyHeartbeat(
  cwd: string,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  // Nothing to protect outside a managed tree — hand back an inert stop.
  if (worktreeRootFor(cwd) === undefined) return stop;
  timer = setInterval(() => { void touchWorktreeOccupancy(cwd); }, intervalMs);
  timer.unref();
  return stop;
}
