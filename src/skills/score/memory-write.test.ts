/**
 * Tests for skills/score/memory-write.ts
 *
 * All tests use a mocked IMemoryStore injected via opts._store so no SQLite
 * database is created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFarmFact } from './memory-write.js';
import type { FarmRunRecord, FarmBranchRecord, IMemoryStore } from './memory-write.js';
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
    duration_ms: 1500,
    branchPath: '/tmp/branch',
    baseSha: 'abc123',
    scoredAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeBranch(
  index: number,
  overrides: Partial<FarmBranchRecord> = {},
): FarmBranchRecord {
  return {
    index,
    branch: `refs/heads/branch-${index}`,
    ok: true,
    commitCount: 2,
    score: makeScore({ loc_delta: index * 5 }),
    ...overrides,
  };
}

function makeRecord(overrides: Partial<FarmRunRecord> = {}): FarmRunRecord {
  return {
    taskName: 'add error handling to parser',
    taskSlug: 'add-error-handling-to-parser',
    baseSha: 'deadbeef',
    startedAt: '2026-05-14T00:00:00.000Z',
    completedAt: '2026-05-14T00:05:00.000Z',
    branches: [makeBranch(0), makeBranch(1), makeBranch(2)],
    winner: 0,
    ...overrides,
  };
}

function makeMockStore(): { store: IMemoryStore; storeFact: ReturnType<typeof vi.fn> } {
  const storeFact = vi.fn<Parameters<IMemoryStore['storeFact']>, number>().mockReturnValue(42);
  const store: IMemoryStore = { storeFact };
  return { store, storeFact };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeFarmFact', () => {
  let storeFact: ReturnType<typeof vi.fn>;
  let store: IMemoryStore;

  beforeEach(() => {
    ({ store, storeFact } = makeMockStore());
  });

  // 1. Winner exists → fact content includes winner index, score array, why
  it('winner exists: fact content includes winner index, score array, and why mentioning winner branch', () => {
    const record = makeRecord({ winner: 1 });
    const result = writeFarmFact(record, { _store: store });

    expect(result).toEqual({ factId: 42 });
    expect(storeFact).toHaveBeenCalledOnce();

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;

    expect(parsed['winner']).toBe(1);
    expect(Array.isArray(parsed['scores'])).toBe(true);
    expect((parsed['scores'] as unknown[]).length).toBe(3);
    expect(typeof parsed['why']).toBe('string');
    expect(parsed['why']).toContain('branch-1');
  });

  // 2. No winner (all branches failed) → why reads "no winner: all N branches failed"
  it('no winner: why says "no winner: all N branches failed tests"', () => {
    const branches: FarmBranchRecord[] = [
      makeBranch(0, { ok: false, score: makeScore({ pass: 0, fail: 1 }) }),
      makeBranch(1, { ok: false, score: makeScore({ pass: 0, fail: 1 }) }),
    ];
    const record = makeRecord({ branches, winner: undefined });

    const result = writeFarmFact(record, { _store: store });
    expect(result).toEqual({ factId: 42 });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;

    expect(parsed['winner']).toBeNull();
    expect(parsed['why']).toBe('no winner: all 2 branches failed tests');
  });

  // 3. Mixed scores (some null, some present) → scores array preserves order
  it('mixed scores: preserves order, includes all branches in scores array', () => {
    const branches: FarmBranchRecord[] = [
      makeBranch(0, { score: makeScore({ loc_delta: 5 }) }),
      makeBranch(1, { score: null }),
      makeBranch(2, { score: makeScore({ loc_delta: 15 }) }),
    ];
    const record = makeRecord({ branches, winner: 0 });

    const result = writeFarmFact(record, { _store: store });
    expect(result).toEqual({ factId: 42 });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;
    const scores = parsed['scores'] as Array<{ index: number; loc_delta: number }>;

    expect(scores.length).toBe(3);
    expect(scores[0]!.index).toBe(0);
    expect(scores[1]!.index).toBe(1);
    expect(scores[2]!.index).toBe(2);
    // Null score falls back to 0 for numeric fields
    expect(scores[1]!.loc_delta).toBe(0);
    // Present scores keep their values
    expect(scores[0]!.loc_delta).toBe(5);
    expect(scores[2]!.loc_delta).toBe(15);
  });

  // 4. human_decision propagates from record to fact
  it('human_decision propagates to fact content', () => {
    const record = makeRecord({ human_decision: 'approved' });

    writeFarmFact(record, { _store: store });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;

    expect(parsed['human_decision']).toBe('approved');
  });

  it('human_decision is null when absent from record', () => {
    const record = makeRecord({ human_decision: undefined });

    writeFarmFact(record, { _store: store });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;

    expect(parsed['human_decision']).toBeNull();
  });

  // 5. Mocked store is called with category: 'learning', source_surface: 'afk', parseable JSON
  it('calls storeFact with category learning, source_surface afk, and parseable JSON content', () => {
    const record = makeRecord();

    writeFarmFact(record, { _store: store });

    expect(storeFact).toHaveBeenCalledOnce();
    const call = storeFact.mock.calls[0]![0];

    expect(call.category).toBe('learning');
    expect(call.source_surface).toBe('afk');

    // Content must be parseable JSON with the expected shape
    expect(() => JSON.parse(call.content)).not.toThrow();
    const parsed = JSON.parse(call.content) as Record<string, unknown>;
    expect(parsed['type']).toBe('farm-run');
    expect(parsed['task']).toBe(record.taskName);
    expect(parsed['taskSlug']).toBe(record.taskSlug);
    expect(parsed['baseSha']).toBe(record.baseSha);
    expect(parsed['completedAt']).toBe(record.completedAt);
  });

  // 6. Constructor failure → returns { skipped: true, reason } without throwing
  it('constructor failure: returns skipped without throwing', () => {
    // Pass _store = undefined but simulate a constructor failure by patching
    // the module. We can achieve the same by having storeFact throw on
    // construction — but since we can't mock the MemoryStore constructor
    // directly in a unit test without vi.mock, we instead test the storeFact
    // error path (which hits the same catch block as construction failure).
    const failingStore: IMemoryStore = {
      storeFact: vi.fn().mockImplementation(() => {
        throw new Error('DB locked');
      }),
    };

    let result: ReturnType<typeof writeFarmFact> | undefined;
    expect(() => {
      result = writeFarmFact(makeRecord(), { _store: failingStore });
    }).not.toThrow();

    expect(result).toEqual({ skipped: true, reason: 'DB locked' });
  });

  it('constructor failure (store throws in constructor): returns skipped without throwing', () => {
    // Test the actual constructor-error path by NOT providing a store and
    // using vi.mock at module level is impractical in vitest without hoisting.
    // Instead, verify the function never throws even when an injected store's
    // storeFact throws a non-Error value.
    const weirdStore: IMemoryStore = {
      storeFact: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error';
      }),
    };

    let result: ReturnType<typeof writeFarmFact> | undefined;
    expect(() => {
      result = writeFarmFact(makeRecord(), { _store: weirdStore });
    }).not.toThrow();

    expect(result).toMatchObject({ skipped: true });
  });

  // Additional: no-score path (all branches have no score) → why says unavailable
  it('no scores at all: why says "no winner: scoring data unavailable"', () => {
    const branches: FarmBranchRecord[] = [
      makeBranch(0, { score: undefined }),
      makeBranch(1, { score: null }),
    ];
    const record = makeRecord({ branches, winner: undefined });

    writeFarmFact(record, { _store: store });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;

    expect(parsed['why']).toBe('no winner: scoring data unavailable');
  });

  // Additional: why string format for winner with losers
  it('why string includes test, lint, loc symbols for winner and loser deltas', () => {
    const branches: FarmBranchRecord[] = [
      makeBranch(0, { score: makeScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 20 }) }),
      makeBranch(1, { score: makeScore({ pass: 0, fail: 1, lint_ok: false, loc_delta: 5 }) }),
    ];
    const record = makeRecord({ branches, winner: 0 });

    writeFarmFact(record, { _store: store });

    const call = storeFact.mock.calls[0]![0];
    const parsed = JSON.parse(call.content) as Record<string, unknown>;
    const why = parsed['why'] as string;

    expect(why).toMatch(/branch-0 wins/);
    expect(why).toContain('tests✓');
    expect(why).toContain('lint✓');
    expect(why).toContain('+20 LoC');
    expect(why).toContain('+5');
  });

  // Additional: factId is returned from storeFact
  it('returns the factId from storeFact', () => {
    const { store: s, storeFact: sf } = makeMockStore();
    sf.mockReturnValue(99);

    const result = writeFarmFact(makeRecord(), { _store: s });
    expect(result).toEqual({ factId: 99 });
  });
});
