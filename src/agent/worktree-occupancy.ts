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
 * Residual gap (accepted): a subagent running longer than MIN_EMPTY_AGE_MS
 * (1h) in a tree that stays clean can still cross the `empty` threshold.
 * The `worktree` tool's `keep` action (git worktree lock) is the sanctioned
 * escape hatch for anything that must survive unconditionally.
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
