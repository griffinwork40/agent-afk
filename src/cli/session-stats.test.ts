/**
 * Tests for src/cli/slash/session-stats.ts
 */

import { describe, it, expect } from 'vitest';
import { createSessionStats, recordTurn, resetStats } from './slash/session-stats.js';

describe('session-stats', () => {
  it('createSessionStats defaults are sensible', () => {
    const s = createSessionStats('sonnet');
    expect(s.totalTurns).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.model).toBe('sonnet');
    expect(s.planMode).toBe(false);
    expect(s.turns).toEqual([]);
    expect(s.sessionStartTime).toBeGreaterThan(0);
  });

  it('recordTurn folds metadata into totals and appends a TurnRecord', () => {
    const s = createSessionStats('sonnet');
    const meta = {
      totalCostUsd: 0.02,
      durationMs: 1500,
      usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 500 },
      sessionId: 'session-abc',
    };
    const rec = recordTurn(s, 'hello', 'hi back', meta);
    expect(s.totalTurns).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.02);
    expect(s.totalDurationMs).toBe(1500);
    expect(s.totalTokens).toBe(1300);
    expect(s.turnCosts).toEqual([0.02]);
    expect(s.turnTokens).toEqual([{ input: 1000, output: 300, cache: 500 }]);
    expect(s.turns).toHaveLength(1);
    expect(s.sessionId).toBe('session-abc');
    expect(rec.user).toBe('hello');
    expect(rec.assistant).toBe('hi back');
  });

  it('recordTurn accumulates across multiple turns', () => {
    const s = createSessionStats('sonnet');
    recordTurn(s, 'q1', 'a1', { totalCostUsd: 0.01, durationMs: 1000, usage: { input_tokens: 100, output_tokens: 50 } });
    recordTurn(s, 'q2', 'a2', { totalCostUsd: 0.02, durationMs: 2000, usage: { input_tokens: 200, output_tokens: 80 } });
    expect(s.totalTurns).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(0.03);
    expect(s.totalDurationMs).toBe(3000);
    expect(s.totalTokens).toBe(430);
    expect(s.turns).toHaveLength(2);
  });

  it('recordTurn tolerates missing metadata', () => {
    const s = createSessionStats('sonnet');
    const rec = recordTurn(s, 'x', 'y', undefined);
    expect(s.totalTurns).toBe(1);
    expect(rec.costUsd).toBe(0);
    expect(rec.durationMs).toBe(0);
  });

  it('recordTurn stores tool events when provided', () => {
    const s = createSessionStats('sonnet');
    const tools = [
      { toolName: 'write_file', toolUseId: 'tu_1', input: '{"file_path":"/tmp/x.ts","content":"hi"}', result: 'Wrote 2 bytes to /tmp/x.ts' },
      { toolName: 'bash', toolUseId: 'tu_2', input: '{"command":"pnpm test"}', result: 'All tests pass', isError: false },
    ];
    const rec = recordTurn(s, 'build it', 'done', { totalCostUsd: 0.01, durationMs: 500, usage: { input_tokens: 100, output_tokens: 50 } }, tools);
    expect(rec.toolEvents).toHaveLength(2);
    expect(rec.toolEvents![0]!.toolName).toBe('write_file');
    expect(rec.toolEvents![1]!.result).toBe('All tests pass');
  });

  it('recordTurn omits toolEvents field when array is empty', () => {
    const s = createSessionStats('sonnet');
    const rec = recordTurn(s, 'hello', 'hi', undefined, []);
    expect(rec.toolEvents).toBeUndefined();
  });

  it('recordTurn omits toolEvents field when not provided', () => {
    const s = createSessionStats('sonnet');
    const rec = recordTurn(s, 'hello', 'hi', undefined);
    expect(rec.toolEvents).toBeUndefined();
  });

  it('turnTokens uses last iteration for context-footprint when iterations are present', () => {
    // Simulates the multi-iteration agent loop that caused the spurious
    // "context 100% used of 1m" bug: aggregate top-level cache_read is
    // huge (~1M summed across 20 tool-use iterations), but the per-call
    // context footprint (last iteration) is modest (~50k).
    const s = createSessionStats('opus_1m');
    const iterations = Array.from({ length: 20 }, () => ({
      input_tokens: 200,
      output_tokens: 500,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    const meta = {
      totalCostUsd: 3.5,
      durationMs: 284_000,
      usage: {
        input_tokens: 4_000,       // aggregate: 20 * 200
        output_tokens: 10_000,     // aggregate: 20 * 500
        cache_read_input_tokens: 1_000_000, // aggregate: 20 * 50k — hits limit
        cache_creation_input_tokens: 0,
        iterations,
      },
    };
    recordTurn(s, 'task', 'done', meta);
    // Per-turn record holds the LAST iteration's values, not aggregates.
    // `footprint` (input+output+cache of the last iteration) is the
    // context-window occupancy used by the status line / footer.
    expect(s.turnTokens).toEqual([
      { input: 200, output: 500, cache: 50_000, footprint: 50_700 },
    ]);
    // Session totals still use aggregates (what the user has actually consumed).
    expect(s.totalTokens).toBe(14_000);
  });

  it('turnTokens falls back to aggregate when iterations not present', () => {
    const s = createSessionStats('sonnet');
    const meta = {
      usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 500 },
    };
    recordTurn(s, 'x', 'y', meta);
    expect(s.turnTokens).toEqual([{ input: 1000, output: 300, cache: 500 }]);
  });

  it('recordTurn sums cache_read_input_tokens and cache_creation_input_tokens', () => {
    const s = createSessionStats('sonnet');
    const meta = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
      },
    };
    recordTurn(s, 'hello', 'hi back', meta);
    expect(s.turnTokens).toEqual([{ input: 100, output: 50, cache: 500 }]);
  });

  it('recordTurn sums cache tokens across iterations', () => {
    const s = createSessionStats('opus_1m');
    const iterations = Array.from({ length: 3 }, () => ({
      input_tokens: 200,
      output_tokens: 500,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 10_000,
    }));
    const meta = {
      totalCostUsd: 3.5,
      durationMs: 284_000,
      usage: {
        input_tokens: 600,
        output_tokens: 1_500,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 30_000,
        iterations,
      },
    };
    recordTurn(s, 'task', 'done', meta);
    // Per-turn record holds the LAST iteration's values summed
    expect(s.turnTokens).toEqual([
      { input: 200, output: 500, cache: 60_000, footprint: 60_700 },
    ]);
  });

  it('prefers provider context_window_tokens as footprint (real anthropic path: no iterations array)', () => {
    // Top-level usage: input/output are CUMULATIVE across rounds, cache is the
    // LATEST round. Their sum (460k) overcounts the window; context_window_tokens
    // (410k) is the provider's true last-round footprint and must win.
    const s = createSessionStats('sonnet_1m');
    const meta = {
      usage: {
        input_tokens: 50_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 399_000,
        cache_creation_input_tokens: 1_000,
        context_window_tokens: 410_000,
      },
    };
    recordTurn(s, 'q', 'a', meta);
    expect(s.turnTokens).toEqual([
      { input: 50_000, output: 10_000, cache: 400_000, footprint: 410_000 },
    ]);
  });

  it('omits footprint when neither iterations nor context_window_tokens are present', () => {
    const s = createSessionStats('sonnet');
    recordTurn(s, 'q', 'a', { usage: { input_tokens: 1_000, output_tokens: 300 } });
    expect(s.turnTokens).toEqual([{ input: 1_000, output: 300, cache: 0 }]);
  });
});

describe('resetStats', () => {
  it('zeroes counters and refreshes sessionStartTime', async () => {
    const s = createSessionStats('sonnet');
    recordTurn(s, 'q', 'a', {
      totalCostUsd: 0.01,
      durationMs: 500,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(s.totalTurns).toBe(1);
    const before = s.sessionStartTime;
    // Yield so the post-reset Date.now() can advance past `before` even on
    // very fast machines. 1ms is plenty for the millisecond-resolution clock.
    await new Promise((r) => setTimeout(r, 2));
    resetStats(s);
    expect(s.totalTurns).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.totalDurationMs).toBe(0);
    expect(s.sessionStartTime).toBeGreaterThan(before);
  });

  it('truncates per-turn arrays in place', () => {
    const s = createSessionStats('sonnet');
    recordTurn(s, 'q', 'a', {
      totalCostUsd: 0.01,
      durationMs: 500,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const turnsRef = s.turns;
    const costsRef = s.turnCosts;
    const tokensRef = s.turnTokens;
    resetStats(s);
    expect(s.turns).toHaveLength(0);
    expect(s.turnCosts).toHaveLength(0);
    expect(s.turnTokens).toHaveLength(0);
    // In-place truncation, not reassignment — same array identity.
    expect(s.turns).toBe(turnsRef);
    expect(s.turnCosts).toBe(costsRef);
    expect(s.turnTokens).toBe(tokensRef);
  });

  it('drops sessionId but preserves model and planMode', () => {
    const s = createSessionStats('sonnet');
    s.planMode = true;
    recordTurn(s, 'q', 'a', {
      totalCostUsd: 0,
      durationMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: 'old-id',
    });
    expect(s.sessionId).toBe('old-id');
    resetStats(s);
    expect(s.sessionId).toBeUndefined();
    expect(s.model).toBe('sonnet');
    expect(s.planMode).toBe(true);
  });

  it('drops the auto-derived name so the next conversation re-derives its own', () => {
    const s = createSessionStats('sonnet');
    s.name = 'old-conversation-name';
    resetStats(s);
    expect(s.name).toBeUndefined();
  });

  it('is idempotent on a fresh stats object', () => {
    const s = createSessionStats('sonnet');
    expect(() => resetStats(s)).not.toThrow();
    expect(s.totalTurns).toBe(0);
    expect(s.sessionId).toBeUndefined();
  });
});
