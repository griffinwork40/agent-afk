/**
 * Tests for /good and /bad REPL slash commands.
 *
 * Mocks the outcome store so tests never touch the real ~/.afk filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { goodCmd, badCmd } from './feedback.js';
import type { SlashContext, SessionStats } from '../types.js';

// ---------------------------------------------------------------------------
// Mock the outcome store
// ---------------------------------------------------------------------------

vi.mock('../../../agent/outcomes/store.js', () => ({
  upsertVotes: vi.fn(),
}));

import { upsertVotes } from '../../../agent/outcomes/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(upsertVotes).mockReset(); // reset both calls and implementation
});

describe('/good', () => {
  it('warns when sessionId is not yet known', async () => {
    const { ctx, lines } = makeCtx(makeStats()); // no sessionId
    const result = await goodCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => /WARN:.*not yet assigned/i.test(l))).toBe(true);
    expect(upsertVotes).not.toHaveBeenCalled();
  });

  it('records an explicit_feedback +1 vote and prints confirmation', async () => {
    const { ctx, lines } = makeCtx(makeStats({ sessionId: 'sess-123' }));
    const result = await goodCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(upsertVotes).toHaveBeenCalledOnce();
    const [sid, votes] = vi.mocked(upsertVotes).mock.calls[0]!;
    expect(sid).toBe('sess-123');
    expect(votes[0]?.lf).toBe('explicit_feedback');
    expect(votes[0]?.vote).toBe(1);
    expect(votes[0]?.strength).toBe('strong');
    expect(lines.some((l) => /SUCCESS:.*succeeded/i.test(l))).toBe(true);
  });

  it('uses the provided note as evidence', async () => {
    const { ctx } = makeCtx(makeStats({ sessionId: 'sess-note' }));
    await goodCmd.handler(ctx, 'great job!');
    const [, votes] = vi.mocked(upsertVotes).mock.calls[0]!;
    expect(votes[0]?.evidence).toBe('great job!');
  });

  it('defaults evidence to "operator" when no note is given', async () => {
    const { ctx } = makeCtx(makeStats({ sessionId: 'sess-default' }));
    await goodCmd.handler(ctx, '');
    const [, votes] = vi.mocked(upsertVotes).mock.calls[0]!;
    expect(votes[0]?.evidence).toBe('operator');
  });

  it('prints error message when upsertVotes throws', async () => {
    vi.mocked(upsertVotes).mockImplementation(() => { throw new Error('disk full'); });
    const { ctx, lines } = makeCtx(makeStats({ sessionId: 'sess-err' }));
    const result = await goodCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => /ERROR:.*disk full/i.test(l))).toBe(true);
  });
});

describe('/bad', () => {
  it('warns when sessionId is not yet known', async () => {
    const { ctx, lines } = makeCtx(makeStats());
    const result = await badCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => /WARN:.*not yet assigned/i.test(l))).toBe(true);
    expect(upsertVotes).not.toHaveBeenCalled();
  });

  it('records an explicit_feedback -1 vote and prints confirmation', async () => {
    const { ctx, lines } = makeCtx(makeStats({ sessionId: 'sess-456' }));
    const result = await badCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(upsertVotes).toHaveBeenCalledOnce();
    const [sid, votes] = vi.mocked(upsertVotes).mock.calls[0]!;
    expect(sid).toBe('sess-456');
    expect(votes[0]?.vote).toBe(-1);
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('failed'))).toBe(true);
  });

  it('uses the provided note as evidence', async () => {
    const { ctx } = makeCtx(makeStats({ sessionId: 'sess-badnote' }));
    await badCmd.handler(ctx, 'wrong answer');
    const [, votes] = vi.mocked(upsertVotes).mock.calls[0]!;
    expect(votes[0]?.evidence).toBe('wrong answer');
  });
});
