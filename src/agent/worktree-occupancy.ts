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
 * What the heartbeat is actually for. A forked subagent runs IN THIS PROCESS
 * (`new AgentSession(...)` — `subagent.ts` spawns nothing), so once the touch
 * above has stamped `pid = process.pid`, `ownerLiveness` resolves to 'alive'
 * for the child's entire run and the `empty` verdict — which requires
 * `ownerLiveness !== 'alive'` — is unreachable however long the child runs.
 * The age gate is therefore NOT the thing that protects a correctly-stamped
 * tree, and `startWorktreeOccupancyHeartbeat` is defence-in-depth rather than
 * the primary guard. It covers the states where the stamp is missing or
 * untrustworthy: a meta file that is absent or unparseable, a torn read of a
 * concurrent write, or an initial touch that failed transiently. In those
 * states `ownerLiveness` degrades to 'unknown' and the age gate becomes the
 * only defence, so re-asserting `createdAt` on a 10-minute cadence is what
 * keeps the tree out of `empty` until the child finishes.
 *
 * Because a torn read is one of the states being defended against, the write
 * itself must be atomic — see `touchWorktreeOccupancy`.
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
 * Exported (alongside `worktree-sweep.ts`'s `MIN_EMPTY_AGE_MS`) so the margin
 * between the two is a checkable relationship instead of a prose comment
 * linking two private constants in different files — see
 * `worktree-occupancy.test.ts`'s "heartbeat interval stays comfortably below
 * the sweep's age gate" assertion.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 600_000; // 10 minutes

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
 *
 * Invariant: the write is atomic (temp file in the same directory, then
 * `rename`) and must stay that way. A plain `writeFile` truncates before it
 * fills, so a sweep reading the meta mid-write gets invalid JSON, treats the
 * tree as having no owner, and drops `ownerLiveness` to 'unknown' — the exact
 * state in which the tree becomes reapable. The heartbeat rewrites this file
 * every 10 minutes for the life of every dispatched child, so a non-atomic
 * write would multiply that window rather than close it. `rename` within one
 * directory is atomic on POSIX and on NTFS, so a concurrent reader sees either
 * the old meta or the new one, never a partial one.
 */
export async function touchWorktreeOccupancy(cwd: string): Promise<void> {
  const root = worktreeRootFor(cwd);
  if (root === undefined) return;
  const metaPath = join(root, META_FILENAME);
  const tmpPath = `${metaPath}.${process.pid}.tmp`;
  try {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      meta = { owner: 'agent' };
    }
    meta['pid'] = process.pid;
    meta['createdAt'] = new Date().toISOString();
    await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf-8');
    await fs.rename(tmpPath, metaPath);
  } catch {
    // Best-effort — never block dispatch. Drop the temp file if the rename
    // never happened, so a failed touch cannot litter the worktree.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Keep the worktree containing `cwd` marked as occupied for as long as the
 * caller runs, returning the function that stops it.
 *
 * Contract: this is defence-in-depth, not the primary guard. For a tree whose
 * meta carries this process's pid the `empty` verdict is already unreachable —
 * it requires `ownerLiveness !== 'alive'`, and an in-process child keeps that
 * pid alive for its whole run, so `createdAt` never gets consulted. The
 * heartbeat matters only where the stamp is missing or untrustworthy (absent
 * or unparseable meta, torn read, transient initial-touch failure); there
 * `ownerLiveness` is 'unknown' and the MIN_EMPTY_AGE_MS gate is the only thing
 * standing between a live child and `remove --force`. Re-asserting `createdAt`
 * every 10 minutes keeps that gate armed for as long as the child runs.
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
