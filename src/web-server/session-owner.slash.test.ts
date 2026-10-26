/**
 * Tests for session-owner.slash.ts — per-session SessionStats tracker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** Untyped call-through mock; the precise signature is irrelevant to these tests. */
type AnyMock = Mock<(...args: unknown[]) => unknown>;

let mockCreateSessionStats: AnyMock;
let mockRecordTurn: AnyMock;

vi.mock('../cli/slash/session-stats.js', () => ({
  createSessionStats: (...args: unknown[]) => mockCreateSessionStats(...args),
  recordTurn: (...args: unknown[]) => mockRecordTurn(...args),
}));

import {
  initSessionStats,
  getStats,
  onTurnDrained,
  buildSessionRef,
  resetSessionStatsForTest,
} from './session-owner.slash.js';

const FAKE_STATS = {
  totalTurns: 0,
  totalCostUsd: 0,
  unpricedTurns: 0,
  totalTokens: 0,
  totalDurationMs: 0,
  sessionStartTime: Date.now(),
  turnCosts: [],
  turnTokens: [],
  turns: [],
  model: 'claude-3-5-sonnet-20241022',
  permissionMode: 'default' as const,
};

beforeEach(() => {
  resetSessionStatsForTest();
  mockCreateSessionStats = vi.fn().mockReturnValue(FAKE_STATS);
  mockRecordTurn = vi.fn();
});

describe('initSessionStats + getStats', () => {
  it('round-trips: getStats returns the stats created for the id', () => {
    initSessionStats('sess-1', 'claude-3-5-sonnet-20241022');
    expect(mockCreateSessionStats).toHaveBeenCalledWith('claude-3-5-sonnet-20241022');
    expect(getStats('sess-1')).toBe(FAKE_STATS);
  });

  it('returns undefined for an unknown session id', () => {
    expect(getStats('unknown-id')).toBeUndefined();
  });

  it('different sessions have independent stats', () => {
    const statsA = { ...FAKE_STATS, model: 'model-a' };
    const statsB = { ...FAKE_STATS, model: 'model-b' };
    mockCreateSessionStats.mockReturnValueOnce(statsA).mockReturnValueOnce(statsB);
    initSessionStats('sess-a', 'model-a');
    initSessionStats('sess-b', 'model-b');
    expect(getStats('sess-a')).toBe(statsA);
    expect(getStats('sess-b')).toBe(statsB);
  });
});

describe('onTurnDrained', () => {
  it('calls recordTurn with the correct args', () => {
    initSessionStats('sess-1', 'sonnet');
    const meta = { totalCostUsd: 0.001, totalTokens: 100, durationMs: 200 } as never;
    onTurnDrained('sess-1', 'user input', 'assistant text', meta);
    expect(mockRecordTurn).toHaveBeenCalledWith(FAKE_STATS, 'user input', 'assistant text', meta);
  });

  it('does nothing for an unknown session id', () => {
    onTurnDrained('unknown', 'user', 'asst', undefined);
    expect(mockRecordTurn).not.toHaveBeenCalled();
  });
});

describe('buildSessionRef', () => {
  it('returns { current: session } for a known session', () => {
    const fakeSession = { sessionId: 'abc' } as never;
    const ref = buildSessionRef(fakeSession);
    expect(ref.current).toBe(fakeSession);
  });

  it('returns { current: undefined } for an unknown id (undefined session)', () => {
    // Runtime tolerates a missing session (map lookup miss); the type does not.
    const ref = buildSessionRef(undefined as unknown as Parameters<typeof buildSessionRef>[0]);
    expect(ref.current).toBeUndefined();
  });
});
