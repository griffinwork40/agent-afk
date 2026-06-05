/**
 * Tests for src/skills/score/digest.ts
 */

import { describe, it, expect } from 'vitest';
import { formatFarmDigest, sendFarmDigest } from './digest.js';
import type { FarmRunRecord, FarmBranchRecord } from './digest.js';
import type { BranchScore } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScore(overrides: Partial<BranchScore> = {}): BranchScore {
  return {
    schemaVersion: 1,
    pass: 1,
    fail: 0,
    loc_delta: 10,
    lint_ok: true,
    duration_ms: 1000,
    branchPath: '/tmp/branch',
    baseSha: 'abc1234',
    scoredAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeBranch(overrides: Partial<FarmBranchRecord>): FarmBranchRecord {
  return {
    index: 0,
    branch: 'branch-0',
    ok: true,
    commitCount: 1,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<FarmRunRecord> = {}): FarmRunRecord {
  return {
    taskName: 'add-jose-auth',
    taskSlug: 'add-jose-auth',
    baseSha: 'abc1234def5678',
    startedAt: '2026-05-14T00:00:00.000Z',
    completedAt: '2026-05-14T01:00:00.000Z',
    branches: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path: 3 branches, 1 winner
// ---------------------------------------------------------------------------

describe('formatFarmDigest — happy path', () => {
  it('includes #1, ← winner, and header with 3/3', () => {
    const record = makeRecord({
      branches: [
        makeBranch({ index: 0, branch: 'branch-1', label: 'jose-only', score: makeScore({ loc_delta: 8 }) }),
        makeBranch({ index: 1, branch: 'branch-2', label: 'jose+zod', score: makeScore({ loc_delta: 12 }) }),
        makeBranch({ index: 2, branch: 'branch-3', label: 'shim', score: makeScore({ pass: 0, fail: 1, lint_ok: null, loc_delta: 31 }) }),
      ],
      winner: 1, // branch-2 (index 1)
    });

    const out = formatFarmDigest(record);

    expect(out).toContain('🌱 Farm complete: 3/3 branches');
    expect(out).toContain('#1');
    expect(out).toContain('← winner');
    expect(out).toContain('branch-2');
  });
});

// ---------------------------------------------------------------------------
// 2. Mixed: 2 ok + 1 failed-no-commits → failed branch appears last
// ---------------------------------------------------------------------------

describe('formatFarmDigest — mixed ok/failed', () => {
  it('puts failed branch last with "failed:" prefix', () => {
    const record = makeRecord({
      branches: [
        makeBranch({ index: 0, branch: 'branch-1', score: makeScore() }),
        makeBranch({ index: 1, branch: 'branch-2', score: makeScore() }),
        makeBranch({ index: 2, branch: 'branch-3', ok: false, commitCount: 0, error: 'no commits made' }),
      ],
      winner: 0,
    });

    const out = formatFarmDigest(record);
    const lines = out.split('\n').filter((l) => l.startsWith('#'));

    // branch-3 (failed) must appear last
    expect(lines[lines.length - 1]).toContain('failed: no commits made');
    expect(lines[lines.length - 1]).toContain('branch-3');

    // At least one of the first lines is not a failed branch
    expect(lines[0]).not.toContain('failed:');
  });
});

// ---------------------------------------------------------------------------
// 3. All branches failed → ⚠ no branch won, 0/N
// ---------------------------------------------------------------------------

describe('formatFarmDigest — all failed', () => {
  it('shows 0/N in header and ⚠ no branch won', () => {
    const record = makeRecord({
      branches: [
        makeBranch({ index: 0, branch: 'branch-1', ok: false, commitCount: 0, error: 'timed out' }),
        makeBranch({ index: 1, branch: 'branch-2', ok: false, commitCount: 0, error: 'build error' }),
      ],
      winner: undefined,
    });

    const out = formatFarmDigest(record);

    expect(out).toContain('🌱 Farm complete: 0/2 branches');
    expect(out).toContain('⚠ no branch won');
  });
});

// ---------------------------------------------------------------------------
// 4. Labels rendered when present, omitted when absent
// ---------------------------------------------------------------------------

describe('formatFarmDigest — labels', () => {
  it('renders label in parens when present', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'branch-1', label: 'my-label', score: makeScore() })],
      winner: 0,
    });

    const out = formatFarmDigest(record);
    expect(out).toContain('(my-label)');
  });

  it('omits parens when label is absent', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'branch-1', score: makeScore() })],
      winner: 0,
    });

    const out = formatFarmDigest(record);
    // No parenthetical label
    const branchLine = out.split('\n').find((l) => l.includes('branch-1'))!;
    expect(branchLine).toBeDefined();
    expect(branchLine).not.toMatch(/\([^)]+\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. LoC signs: positive, negative, zero
// ---------------------------------------------------------------------------

describe('formatFarmDigest — LoC signs', () => {
  it('shows +N for positive LoC delta', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'branch-1', score: makeScore({ loc_delta: 42 }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('+42 LoC');
  });

  it('shows -N for negative LoC delta', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'branch-1', score: makeScore({ loc_delta: -7 }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('-7 LoC');
  });

  it('shows 0 for zero LoC delta', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'branch-1', score: makeScore({ loc_delta: 0 }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('0 LoC');
  });
});

// ---------------------------------------------------------------------------
// 6. Lint icons: all three states
// ---------------------------------------------------------------------------

describe('formatFarmDigest — lint icons', () => {
  it('shows lint✓ when lint_ok=true', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore({ lint_ok: true }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('lint✓');
  });

  it('shows lint✗ when lint_ok=false', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore({ lint_ok: false }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('lint✗');
  });

  it('shows lint? when lint_ok=null', () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore({ lint_ok: null }) })],
      winner: 0,
    });
    expect(formatFarmDigest(record)).toContain('lint?');
  });
});

// ---------------------------------------------------------------------------
// 7. sendFarmDigest — mock _push returning results → {sent: true, chatCount}
// ---------------------------------------------------------------------------

describe('sendFarmDigest — push success', () => {
  it('returns {sent: true, chatCount} when push resolves with results', async () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore() })],
      winner: 0,
    });

    const mockPush = async (_text: string) => [
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ];

    const result = await sendFarmDigest(record, { _push: mockPush });
    expect(result).toEqual({ sent: true, chatCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// 8. sendFarmDigest — mock _push returning null → {sent: false, reason}
// ---------------------------------------------------------------------------

describe('sendFarmDigest — push unconfigured', () => {
  it('returns {sent: false, reason: "telegram unconfigured"} when push returns null', async () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore() })],
    });

    const mockPush = async (_text: string) => null;

    const result = await sendFarmDigest(record, { _push: mockPush });
    expect(result).toEqual({ sent: false, reason: 'telegram unconfigured' });
  });
});

// ---------------------------------------------------------------------------
// 9. sendFarmDigest — mock _push throwing → {sent: false, reason} (no rethrow)
// ---------------------------------------------------------------------------

describe('sendFarmDigest — push throws', () => {
  it('returns {sent: false, reason} without rethrowing', async () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore() })],
    });

    const mockPush = async (_text: string): Promise<never> => {
      throw new Error('network timeout');
    };

    const result = await sendFarmDigest(record, { _push: mockPush });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('network timeout');
  });
});

// ---------------------------------------------------------------------------
// 10. sendFarmDigest — inline keyboard attached for Day 4b
// ---------------------------------------------------------------------------

describe('sendFarmDigest — inline keyboard', () => {
  it('forwards a 4-button keyboard via reply_markup when scoring produced a winner', async () => {
    const record = makeRecord({
      taskSlug: '20260514t150724-add-jose-auth-abcd',
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore() })],
      winner: 0,
    });

    let captured: { text: string; opts?: { replyMarkup?: unknown } } | undefined;
    const mockPush = async (
      text: string,
      opts?: { replyMarkup?: unknown },
    ): Promise<Array<{ ok: true; status: number }>> => {
      captured = { text, ...(opts !== undefined ? { opts } : {}) };
      return [{ ok: true, status: 200 }];
    };

    const result = await sendFarmDigest(record, { _push: mockPush });
    expect(result).toEqual({ sent: true, chatCount: 1 });
    expect(captured?.opts?.replyMarkup).toBeDefined();
    const markup = captured!.opts!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const allCallbacks = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(allCallbacks).toHaveLength(4);
    expect(allCallbacks).toEqual(
      expect.arrayContaining([
        'afk:f:p:20260514t150724-add-jose-auth-abcd',
        'afk:f:d:20260514t150724-add-jose-auth-abcd',
        'afk:f:r:20260514t150724-add-jose-auth-abcd',
        'afk:f:x:20260514t150724-add-jose-auth-abcd',
      ]),
    );
  });

  it('still attaches a keyboard even when no winner (Discard-all stays useful)', async () => {
    const record = makeRecord({
      taskSlug: 'no-winner-slug',
      branches: [makeBranch({ index: 0, branch: 'b', ok: false, error: 'no commits' })],
      // winner: undefined
    });

    let capturedMarkup: unknown;
    const mockPush = async (
      _text: string,
      opts?: { replyMarkup?: unknown },
    ): Promise<Array<{ ok: true; status: number }>> => {
      capturedMarkup = opts?.replyMarkup;
      return [{ ok: true, status: 200 }];
    };

    await sendFarmDigest(record, { _push: mockPush });
    expect(capturedMarkup).toBeDefined();
  });

  it('plain-text body is unchanged when Telegram is unconfigured (push returns null)', async () => {
    const record = makeRecord({
      branches: [makeBranch({ index: 0, branch: 'b', score: makeScore() })],
      winner: 0,
    });
    const mockPush = async (_text: string) => null;
    const result = await sendFarmDigest(record, { _push: mockPush });
    expect(result).toEqual({ sent: false, reason: 'telegram unconfigured' });
  });
});
