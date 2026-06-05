/**
 * Resolve a farm's winning branch from on-disk state.
 *
 * After `afk farm` finishes, the in-memory `FarmRunRecord.winner` used by the
 * digest is gone — the persistent source of truth is the per-branch score
 * file at `<farmDir>/scores/branch-<index>.json`. Any process that needs to
 * point at the winning branch later (Telegram callbacks, future CLI
 * inspectors) must re-derive winner from those files using the SAME
 * ranking the digest used, or the user-visible "#1 winner" in chat will
 * disagree with what `Full diff` operates on.
 *
 * The selection algorithm mirrors `buildFarmRunRecord()` in
 * `src/cli/commands/farm.ts`:
 *
 *   1. Apply `rankBranches()` to every branch with a persisted score.
 *   2. Winner = first ranked branch where `pass > 0 && fail === 0`.
 *   3. Fallback 1: first ranked branch with any score (lint+LoC tiebreakers
 *      stay meaningful even when all tests failed).
 *   4. Fallback 2: `manifest.branches[0]` — preserves the previous
 *      "show *something*" behavior when no scoring data exists at all
 *      (e.g. farm run with `--no-score`).
 *
 * @module skills/score/winner
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { BranchScore } from './index.js';
import { rankBranches } from './index.js';
import type { CreatedBranch, FarmManifest } from '../../agent/worktree.js';

/**
 * Outcome of winner resolution. `source` tells callers WHY we picked this
 * branch, which matters for UX surfaces (e.g. "showing branch-2 — no winner,
 * falling back to first scored branch").
 */
export interface WinnerResolution {
  branch: CreatedBranch;
  source: 'winner' | 'top-scored' | 'fallback-first-branch';
}

export interface ResolveWinnerDeps {
  /** Inject in tests to bypass disk I/O. Returns null when the score file is absent. */
  loadScore?: (farmDir: string, index: number) => Promise<BranchScore | null>;
}

export async function resolveWinnerBranch(
  manifest: FarmManifest,
  deps: ResolveWinnerDeps = {},
): Promise<WinnerResolution> {
  if (manifest.branches.length === 0) {
    throw new Error(`resolveWinnerBranch: farm ${manifest.taskSlug} has no branches`);
  }

  const loader = deps.loadScore ?? defaultLoadScore;
  const scored = await Promise.all(
    manifest.branches.map(async (b) => ({
      index: b.index,
      score: await loader(manifest.farmDir, b.index),
    })),
  );
  const ranked = rankBranches(scored);

  // Helper: find a CreatedBranch by index. Defensive — manifest.branches is the
  // source of truth, scores list is derived from it.
  const byIndex = new Map<number, CreatedBranch>(manifest.branches.map((b) => [b.index, b]));

  // Tier 1: first ranked branch that passed tests cleanly.
  for (const idx of ranked) {
    const s = scored.find((x) => x.index === idx)?.score;
    if (s && s.pass > 0 && s.fail === 0) {
      const b = byIndex.get(idx);
      if (b) return { branch: b, source: 'winner' };
    }
  }

  // Tier 2: first ranked branch with any score at all.
  for (const idx of ranked) {
    const s = scored.find((x) => x.index === idx)?.score;
    if (s) {
      const b = byIndex.get(idx);
      if (b) return { branch: b, source: 'top-scored' };
    }
  }

  // Tier 3: no scoring data at all. Fall back to the first branch by index —
  // matches the previous behavior so a `--no-score` farm still gets a diff.
  return { branch: manifest.branches[0]!, source: 'fallback-first-branch' };
}

async function defaultLoadScore(farmDir: string, index: number): Promise<BranchScore | null> {
  const path = join(farmDir, 'scores', `branch-${index}.json`);
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as BranchScore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Malformed JSON or permission error — surface as "no score" rather than
    // crash the callback. The user-facing alternative (showing nothing at all)
    // is worse.
    return null;
  }
}
