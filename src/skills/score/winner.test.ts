/**
 * Tests for src/skills/score/winner.ts
 */

import { describe, it, expect } from 'vitest';
import { resolveWinnerBranch } from './winner.js';
import type { BranchScore } from './index.js';
import type { CreatedBranch, FarmManifest } from '../../agent/worktree.js';

function makeBranch(index: number, label?: string): CreatedBranch {
  const b: CreatedBranch = {
    index,
    path: `/tmp/farm/branch-${index}`,
    branch: `afk/farm/my-slug/${index}`,
  };
  if (label) b.label = label;
  return b;
}

function makeManifest(branches: CreatedBranch[]): FarmManifest {
  return {
    schemaVersion: 2,
    taskId: 'task-id',
    taskSlug: 'my-slug',
    taskName: 'My task',
    repoRoot: '/tmp/repo',
    baseRef: 'abc1234',
    farmDir: '/tmp/farm',
    createdAt: '2026-05-14T00:00:00.000Z',
    branches,
  };
}

function makeScore(overrides: Partial<BranchScore>): BranchScore {
  return {
    schemaVersion: 1,
    pass: 0,
    fail: 0,
    loc_delta: 0,
    lint_ok: null,
    duration_ms: 0,
    branchPath: '/tmp',
    baseSha: 'abc1234',
    scoredAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveWinnerBranch', () => {
  it('picks the only tests-passing branch when others fail', async () => {
    const manifest = makeManifest([makeBranch(1), makeBranch(2), makeBranch(3)]);
    const loadScore = async (_d: string, index: number) => {
      if (index === 1) return makeScore({ pass: 0, fail: 1 });
      if (index === 2) return makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 12 });
      if (index === 3) return makeScore({ pass: 0, fail: 1 });
      return null;
    };
    const out = await resolveWinnerBranch(manifest, { loadScore });
    expect(out.branch.index).toBe(2);
    expect(out.source).toBe('winner');
  });

  it('breaks ties between tests-passing branches by lint, then loc_delta', async () => {
    const manifest = makeManifest([makeBranch(1), makeBranch(2), makeBranch(3)]);
    const loadScore = async (_d: string, index: number) => {
      // All three pass tests. branch-2 wins lint+LoC tiebreaker.
      if (index === 1) return makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 50 });
      if (index === 2) return makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 12 });
      if (index === 3) return makeScore({ pass: 1, fail: 0, lint_ok: false, loc_delta: 8 });
      return null;
    };
    const out = await resolveWinnerBranch(manifest, { loadScore });
    expect(out.branch.index).toBe(2);
    expect(out.source).toBe('winner');
  });

  it('falls back to top-scored when no branch passes tests', async () => {
    const manifest = makeManifest([makeBranch(1), makeBranch(2)]);
    const loadScore = async (_d: string, index: number) => {
      if (index === 1) return makeScore({ pass: 0, fail: 1, lint_ok: false, loc_delta: 30 });
      if (index === 2) return makeScore({ pass: 0, fail: 1, lint_ok: true, loc_delta: 10 });
      return null;
    };
    const out = await resolveWinnerBranch(manifest, { loadScore });
    expect(out.branch.index).toBe(2); // better lint + smaller LoC
    expect(out.source).toBe('top-scored');
  });

  it('falls back to manifest.branches[0] when no scoring data exists', async () => {
    const manifest = makeManifest([makeBranch(1), makeBranch(2)]);
    const loadScore = async () => null;
    const out = await resolveWinnerBranch(manifest, { loadScore });
    expect(out.branch.index).toBe(1);
    expect(out.source).toBe('fallback-first-branch');
  });

  it('throws on an empty manifest (shouldn’t happen post-createFarm)', async () => {
    const manifest = makeManifest([]);
    await expect(resolveWinnerBranch(manifest, { loadScore: async () => null })).rejects.toThrow(
      /no branches/,
    );
  });

  it('returns winner=branch-2 matching what buildFarmRunRecord would have chosen', async () => {
    // Mirror the integration scenario: 3 branches, branch-2 is the winner.
    // This is the canonical assertion that the on-disk re-derivation agrees
    // with the in-memory derivation used by buildFarmRunRecord.
    const manifest = makeManifest([makeBranch(1, 'a'), makeBranch(2, 'b'), makeBranch(3, 'c')]);
    const loadScore = async (_d: string, index: number) => {
      if (index === 1) return makeScore({ pass: 0, fail: 1 });
      if (index === 2) return makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 10 });
      if (index === 3) return makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 25 });
      return null;
    };
    const out = await resolveWinnerBranch(manifest, { loadScore });
    expect(out.branch.index).toBe(2);
    expect(out.branch.path).toBe('/tmp/farm/branch-2');
    expect(out.source).toBe('winner');
  });
});
