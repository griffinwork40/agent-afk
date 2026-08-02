/**
 * Pins the reporting contract added by the #771 review pass: a tick that
 * removed something must say so, whatever the mix of roots behind it.
 */
import { describe, it, expect } from 'vitest';
import {
  countPrunable,
  formatWorktreePruneSummary,
  type PruneTickTotals,
} from './worktree-prune-summary.js';

function totals(over: Partial<PruneTickTotals> = {}): PruneTickTotals {
  return {
    removed: 0,
    warnings: 0,
    wouldRemove: 0,
    liveRoots: 0,
    previewRoots: 0,
    contestedRoots: 0,
    failedRoots: 0,
    totalRoots: 0,
    ...over,
  };
}

describe('formatWorktreePruneSummary', () => {
  it('F-C1: a MIXED tick reports the real removal count, not just the preview', () => {
    // The regression this module exists for: one live root removed 4 worktrees
    // while a freshly registered root only previewed. The old renderer folded
    // dryRun with some() and printed the dry-run sentence, which has no
    // removal count at all — 4 deletions vanished from the record.
    const line = formatWorktreePruneSummary(
      totals({
        removed: 4, warnings: 1, wouldRemove: 2,
        liveRoots: 1, previewRoots: 1, totalRoots: 2,
      }),
    );

    expect(line).toContain('removed 4');
    expect(line).toContain('would remove 2 on 1 preview root(s)');
    expect(line).toContain('across 2/2 root(s)');
  });

  it('renders an all-live tick without a preview clause', () => {
    const line = formatWorktreePruneSummary(
      totals({ removed: 3, warnings: 2, liveRoots: 2, totalRoots: 2 }),
    );

    expect(line).toContain('✂️');
    expect(line).toContain('removed 3, warned 2');
    expect(line).not.toContain('would remove');
    expect(line).not.toContain('dry-run');
  });

  it('keeps the (dry-run) label for a pure-preview tick, and still states removed 0', () => {
    const line = formatWorktreePruneSummary(
      totals({ wouldRemove: 5, previewRoots: 3, totalRoots: 3 }),
    );

    expect(line).toContain('🔍');
    expect(line).toContain('(dry-run)');
    expect(line).toContain('removed 0');
    expect(line).toContain('would remove 5 on 3 preview root(s)');
  });

  it('F-O2: a contested root counts against the total but not as swept', () => {
    // A root that short-circuited on the machine-global lock never reached the
    // porcelain list. Counting it as swept let a tick claim "3/3 root(s)" when
    // zero roots were actually inspected.
    const line = formatWorktreePruneSummary(
      totals({ liveRoots: 1, contestedRoots: 2, totalRoots: 3 }),
    );

    expect(line).toContain('across 1/3 root(s)');
    expect(line).toContain('2 contested');
  });

  it('names failed roots so a partial failure is visible in the summary', () => {
    const line = formatWorktreePruneSummary(
      totals({ removed: 1, liveRoots: 1, failedRoots: 2, totalRoots: 3 }),
    );

    expect(line).toContain('2 failed');
    expect(line).toContain('across 1/3 root(s)');
  });
});

describe('countPrunable', () => {
  it('counts only verdicts the sweep acts on', () => {
    expect(
      countPrunable([
        { verdict: 'empty' },
        { verdict: 'orphaned-dir' },
        { verdict: 'orphaned-registration' },
        { verdict: 'dead-owner' },
      ]),
    ).toBe(4);
  });

  it('excludes stale-clean and preserved verdicts, which the engine never removes', () => {
    expect(
      countPrunable([
        { verdict: 'stale-clean' },
        { verdict: 'stale-dirty' },
        { verdict: 'orphaned-dir-preserved' },
        { verdict: 'locked' },
        { verdict: 'active' },
      ]),
    ).toBe(0);
  });
});
