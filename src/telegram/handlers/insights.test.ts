/**
 * Tests for the Telegram /insights command handler.
 *
 * Mocks `aggregateAll` and `evaluateRecommendations` from `src/insights/` so
 * no real filesystem I/O occurs. Pattern mirrors inbox.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'telegraf';
import { handleInsights } from './insights.js';

// ---------------------------------------------------------------------------
// Mock the insights barrel
// ---------------------------------------------------------------------------

vi.mock('../../insights/index.js', () => ({
  aggregateAll: vi.fn(),
  evaluateRecommendations: vi.fn(),
}));

import { aggregateAll, evaluateRecommendations } from '../../insights/index.js';

const mockAggregateAll = vi.mocked(aggregateAll);
const mockEvaluateRecommendations = vi.mocked(evaluateRecommendations);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal InsightAggregates for testing. */
function makeAgg(overrides: Record<string, unknown> = {}) {
  return {
    windowDays: 30,
    sessions: {
      totalSessions: 5,
      totalCostUsd: 1.23,
      totalTokens: 10000,
      byDay: {},
      byModel: {},
      bySurface: {},
    },
    daemon: { totalRuns: 3, errorCount: 0, byTaskId: {} },
    traces: {
      totalTracedSessions: 5,
      toolCallCounts: {},
      toolErrorCounts: {},
      toolDurationsMs: {},
      subagentForkDepths: {},
      compactionCount: 0,
      closureReasons: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    routing: { overflowKills: {} },
    outcomes: {},
    preexistingDefects: { topClusters: [], totalDefects: 0 },
    subagentOutcomes: {},
    guardrailFalsePositives: { total: 0, byRule: {} },
    ...overrides,
  };
}

type MockContext = Context & { replyCalls: Array<[string, unknown?]> };

function makeCtx(commandText = '/insights'): MockContext {
  const replyCalls: Array<[string, unknown?]> = [];
  const ctx = {
    message: { text: commandText },
    reply: vi.fn(async (text: string, opts?: unknown) => {
      replyCalls.push([text, opts]);
    }),
    replyCalls,
  } as unknown as MockContext;
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleInsights', () => {
  it('sends aggregation progress message then summary', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([]);

    const ctx = makeCtx('/insights');
    await handleInsights(ctx);

    expect(ctx.replyCalls[0]![0]).toContain('Aggregating');
    const summary = ctx.replyCalls[1]![0] as string;
    expect(summary).toContain('AFK Insights');
    expect(summary).toContain('last 30 day');
    expect(summary).toContain('Sessions:');
    expect(summary).toContain('Cost:');
  });

  it('shows "All clear" when no recommendations', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([]);

    const ctx = makeCtx('/insights');
    await handleInsights(ctx);

    const summary = ctx.replyCalls[1]![0] as string;
    expect(summary).toContain('All clear');
  });

  it('shows recommendations with severity emoji', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([
      { severity: 'high', title: 'Test error', body: 'Something bad happened', metric: 0.9 },
      { severity: 'info', title: 'FYI', body: 'Just so you know', metric: 0.1 },
    ]);

    const ctx = makeCtx('/insights');
    await handleInsights(ctx);

    const summary = ctx.replyCalls[1]![0] as string;
    expect(summary).toContain('🔴');
    expect(summary).toContain('Test error');
    expect(summary).toContain('🔵');
    expect(summary).toContain('FYI');
    expect(summary).toContain('Recommendations (2)');
  });

  it('parses optional days argument', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([]);

    const ctx = makeCtx('/insights 7');
    await handleInsights(ctx);

    expect(mockAggregateAll).toHaveBeenCalledWith({ days: 7 });
    const summary = ctx.replyCalls[1]![0] as string;
    expect(summary).toContain('last 7 day');
  });

  it('clamps days to 90 max', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([]);

    const ctx = makeCtx('/insights 999');
    await handleInsights(ctx);

    expect(mockAggregateAll).toHaveBeenCalledWith({ days: 90 });
  });

  it('replies with error message when aggregateAll throws', async () => {
    mockAggregateAll.mockRejectedValue(new Error('disk read failed'));

    const ctx = makeCtx('/insights');
    await handleInsights(ctx);

    const errorReply = ctx.replyCalls[1]![0] as string;
    expect(errorReply).toContain('Failed to aggregate');
    expect(errorReply).toContain('disk read failed');
  });

  it('defaults to 30 days for invalid day argument', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([]);

    const ctx = makeCtx('/insights abc');
    await handleInsights(ctx);

    expect(mockAggregateAll).toHaveBeenCalledWith({ days: 30 });
  });

  it('escapes HTML in recommendation title and body', async () => {
    mockAggregateAll.mockResolvedValue(makeAgg() as never);
    mockEvaluateRecommendations.mockReturnValue([
      {
        severity: 'medium',
        title: 'Tool "<bash>" has errors',
        body: 'See <details> for more',
        metric: 0.5,
      },
    ]);

    const ctx = makeCtx('/insights');
    await handleInsights(ctx);

    const summary = ctx.replyCalls[1]![0] as string;
    expect(summary).not.toContain('<bash>');
    expect(summary).toContain('&lt;bash&gt;');
  });
});
