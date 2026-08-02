/**
 * Renders the daemon worktree-prune tick's one-line telemetry summary.
 *
 * Invariant: a tick that removed something must SAY it removed something. The
 * previous renderer folded every root's `dryRun` with `some()` and then chose
 * one of two mutually exclusive sentences, so a tick mixing a live root with a
 * previewing one printed "would remove N" and never printed the removal count
 * at all — real deletions vanished from the persisted record and from the
 * operator's push notification (`cli/commands/daemon.ts` forwards
 * `responseExcerpt` verbatim). That fold carried a comment asserting mixed
 * values were unreachable "while the soft-launch valve resolves uniformly per
 * tick"; the valve became PER-ROOT in #771, which made mixed the normal case
 * for any daemon that has just picked up a newly registered repo. This renderer
 * is therefore additive rather than exclusive: removals, previews, contested
 * roots and failed roots each get their own clause, and a clause is emitted
 * whenever its count is non-zero.
 *
 * @module agent/daemon/worktree-prune-summary
 */

/**
 * Verdicts the sweep actually acts on. 'stale-clean' is deliberately absent:
 * the engine preserves and warns on it (commits ahead of base) rather than
 * removing, so counting it as a would-remove would overstate the preview.
 */
const PRUNABLE_VERDICTS: ReadonlySet<string> = new Set([
  'empty',
  'orphaned-dir',
  'orphaned-registration',
  'dead-owner',
]);

/** Per-tick tallies, already aggregated across every root the tick visited. */
export interface PruneTickTotals {
  /** Worktrees actually removed from disk. */
  removed: number;
  /** Warning lines raised across all roots, including per-root failures. */
  warnings: number;
  /** Prunable candidates identified on roots that only previewed. */
  wouldRemove: number;
  /** Roots that swept live. */
  liveRoots: number;
  /** Roots the soft-launch valve held in preview. */
  previewRoots: number;
  /** Roots that returned early because another process held the sweep lock. */
  contestedRoots: number;
  /** Roots whose sweep rejected outright. */
  failedRoots: number;
  /** Roots the tick set out to visit. */
  totalRoots: number;
}

/** Count prunable candidates in a candidate list. */
export function countPrunable(candidates: readonly { verdict: string }[]): number {
  return candidates.filter((c) => PRUNABLE_VERDICTS.has(c.verdict)).length;
}

/**
 * One line, safe to persist and to push. Never claims a removal that did not
 * happen, and never omits one that did.
 */
export function formatWorktreePruneSummary(totals: PruneTickTotals): string {
  const {
    removed, warnings, wouldRemove,
    liveRoots, previewRoots, contestedRoots, failedRoots, totalRoots,
  } = totals;

  const visited = liveRoots + previewRoots;
  const purePreview = liveRoots === 0 && previewRoots > 0;
  const icon = purePreview ? '🔍' : previewRoots > 0 ? '✂️🔍' : '✂️';
  const label = purePreview ? 'worktree-prune (dry-run)' : 'worktree-prune';

  // The removal clause is unconditional — that is the entire point of this
  // module. A pure-preview tick reporting "removed 0" is honest; a mixed tick
  // silently dropping "removed 4" was not.
  const clauses: string[] = [`removed ${String(removed)}, warned ${String(warnings)}`];
  if (previewRoots > 0) {
    clauses.push(`would remove ${String(wouldRemove)} on ${String(previewRoots)} preview root(s)`);
  }
  if (contestedRoots > 0) clauses.push(`${String(contestedRoots)} contested`);
  if (failedRoots > 0) clauses.push(`${String(failedRoots)} failed`);

  // `visited`, not `results.length`: a root that short-circuited on a contested
  // lock never reached the porcelain list, so counting it as swept let a tick
  // report "3/3 root(s)" when zero roots were actually inspected.
  return `${icon} ${label}: ${clauses.join('; ')} across ${String(visited)}/${String(totalRoots)} root(s)`;
}
