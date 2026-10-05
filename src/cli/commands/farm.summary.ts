/**
 * Display helpers for the `afk farm` command.
 *
 * Extracted from farm.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `formatScore`, `printSummary`.
 */

import { palette } from '../palette.js';
import { rankBranches, type BranchScore } from '../../skills/score/index.js';
import type { CreatedBranch } from '../../agent/worktree.js';

// ---------------------------------------------------------------------------
// Internal padding helper
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// BranchResult — the in-memory view of a single branch after the DAG
// ---------------------------------------------------------------------------

export interface BranchResult {
  index: number;
  ok: boolean;
  commitCount: number;
  error?: string;
  /** Populated after scoring. null if scoring was disabled or the branch failed before scoring. */
  score?: BranchScore | null;
}

// ---------------------------------------------------------------------------
// Score formatter
// ---------------------------------------------------------------------------

export function formatScore(score: BranchScore | null | undefined): string {
  if (score === undefined) return palette.dim('—');
  if (score === null) return palette.dim('skipped');
  // Compact: tests + lint + LoC. Test signal is binary in v1.
  const testIcon = score.fail === 0 && score.pass > 0
    ? palette.success('tests✓')
    : palette.error('tests✗');
  const lintIcon = score.lint_ok === true
    ? palette.success('lint✓')
    : score.lint_ok === false
    ? palette.error('lint✗')
    : palette.dim('lint?');
  const sign = score.loc_delta > 0 ? '+' : '';
  const loc = palette.dim(`${sign}${score.loc_delta} LoC`);
  return `${testIcon} ${lintIcon} ${loc}`;
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

export function printSummary(
  taskName: string,
  taskSlug: string,
  branches: CreatedBranch[],
  branchResults: BranchResult[],
): void {
  const line = '─'.repeat(45);
  console.log(palette.dim(line));
  console.log(`farm:    ${taskName}`);
  console.log(`slug:    ${taskSlug}`);
  console.log('');

  // Determine if any scoring data is present — drives ranked-order display.
  const anyScored = branchResults.some((r) => r.score != null);
  const orderedResults = anyScored
    ? rankBranches(
        branchResults.map((r) => ({ index: r.index, score: r.score ?? null })),
      ).map((idx) => branchResults.find((r) => r.index === idx)!)
    : branchResults;

  for (let i = 0; i < orderedResults.length; i++) {
    const r = orderedResults[i]!;
    const branch = branches.find((b) => b.index === r.index)!;
    const icon = r.ok ? palette.success('✓') : palette.error('✗');
    const ref = pad(branch.branch, 40);
    const detail = r.ok
      ? palette.dim(`(${r.commitCount} commit${r.commitCount === 1 ? '' : 's'})`)
      : palette.error(`[error: ${r.error}]`);
    const rank = anyScored ? palette.brand(`#${i + 1} `) : '';
    const scoreCol = anyScored ? `  ${formatScore(r.score)}` : '';
    console.log(`${rank}branch-${r.index}  ${icon}  ${ref}   ${detail}${scoreCol}`);
    console.log(palette.dim(`        worktree: ${branch.path}`));
  }

  console.log(palette.dim(line));
  const succeeded = branchResults.filter((r) => r.ok).length;
  const total = branchResults.length;
  console.log(`${succeeded}/${total} branches completed.`);

  // All-fail warning per Day 3 spec.
  const anyTestsPassed = branchResults.some(
    (r) => r.score != null && r.score.pass > 0,
  );
  if (anyScored && !anyTestsPassed) {
    console.log(palette.warning('⚠  no branch passed tests — ranking falls back to lint + LoC'));
  }
}
