/**
 * FarmRunRecord builder for the `afk farm` command.
 *
 * Extracted from farm.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `buildFarmRunRecord`.
 */

import { rankBranches } from '../../skills/score/index.js';
import type { FarmRunRecord, FarmBranchRecord } from '../../skills/score/farm-run-record.js';
import type { FarmManifest } from '../../agent/worktree.js';
import type { BranchResult } from './farm.summary.js';

/**
 * Build the FarmRunRecord consumed by memory write-through and Telegram digest.
 *
 * Determines the `winner` index by re-running `rankBranches` over the scored
 * results — same algorithm `printSummary` uses, so memory/digest/CLI all agree
 * on which branch is #1. If no branch has a score (scoring disabled or all
 * failed), `winner` is left undefined.
 */
export function buildFarmRunRecord(
  manifest: FarmManifest,
  branchResults: BranchResult[],
  startedAt: string,
): FarmRunRecord {
  const branches: FarmBranchRecord[] = branchResults.map((r) => {
    const meta = manifest.branches.find((b) => b.index === r.index);
    const rec: FarmBranchRecord = {
      index: r.index,
      branch: meta?.branch ?? `(unknown-${r.index})`,
      ok: r.ok,
      commitCount: r.commitCount,
    };
    if (meta?.label !== undefined) rec.label = meta.label;
    if (r.error !== undefined) rec.error = r.error;
    if (r.score !== undefined) rec.score = r.score;
    return rec;
  });

  // Determine winner: rank only branches that have a score, take the first
  // ok-and-tests-passing one.
  const ranked = rankBranches(
    branchResults.map((r) => ({ index: r.index, score: r.score ?? null })),
  );
  let winner: number | undefined;
  for (const idx of ranked) {
    const r = branchResults.find((b) => b.index === idx);
    if (!r || !r.ok || !r.score) continue;
    if (r.score.pass > 0 && r.score.fail === 0) {
      winner = idx;
      break;
    }
  }
  // Fallback: if no branch passed tests but some are `ok` with scoring data,
  // the top-ranked one is still meaningful (lint + LoC tiebreakers).
  if (winner === undefined) {
    for (const idx of ranked) {
      const r = branchResults.find((b) => b.index === idx);
      if (r?.ok && r.score) {
        winner = idx;
        break;
      }
    }
  }

  const record: FarmRunRecord = {
    taskName: manifest.taskName,
    taskSlug: manifest.taskSlug,
    baseSha: manifest.baseRef,
    startedAt,
    completedAt: new Date().toISOString(),
    branches,
  };
  if (winner !== undefined) record.winner = winner;
  if (manifest.human_decision !== undefined) record.human_decision = manifest.human_decision;
  return record;
}
