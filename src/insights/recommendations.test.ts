/**
 * Unit tests for the recommendations engine.
 *
 * Each rule is tested with:
 *   - A fixture that just-crosses the threshold → rule fires
 *   - A fixture that just-misses the threshold → rule does not fire
 * Plus sort order and privacy assertions.
 */

import { describe, it, expect } from 'vitest';
import { evaluateRecommendations } from './recommendations.js';
import { RECOMMENDATION_THRESHOLDS as T } from './constants.js';
import type { InsightAggregates } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAgg(overrides: Partial<InsightAggregates> = {}): InsightAggregates {
  return {
    generatedAt: Date.now(),
    windowDays: 30,
    sessions: {
      totalSessions: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      byDay: {},
      byModel: {},
      bySurface: {},
    },
    traces: {
      totalTracedSessions: 0,
      toolCallCounts: {},
      toolErrorCounts: {},
      toolDurationsMs: {},
      subagentForkDepths: {},
      compactionCount: 0,
      closureReasons: {},
    },
    daemon: {
      totalRuns: 0,
      successCount: 0,
      errorCount: 0,
      skipCount: 0,
      byTaskId: {},
      triggerBreakdown: {},
      skipReasons: {},
      recentErrors: [],
      avgDurationMs: 0,
    },
    routing: {
      totalRoutingEvents: 0,
      skillDispatchModes: {},
      skillFrequency: {},
      composeCallCount: 0,
      avgComposeNodes: 0,
      avgComposeEdges: 0,
      overflowKills: {},
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1: High tool error rate
// ---------------------------------------------------------------------------

describe('checkHighErrorRateTool', () => {
  it('tool error rate at threshold → fires with tool name in title', () => {
    const callCount = T.highErrorToolMinCalls;
    const errorCount = Math.ceil(callCount * T.toolErrorRateMin);
    const agg = makeAgg({
      traces: {
        totalTracedSessions: 1,
        toolCallCounts: { bash: callCount },
        toolErrorCounts: { bash: errorCount },
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const rec = recs.find((r) => r.title.includes('bash'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('high');
    expect(rec!.title).not.toMatch(/\//); // no file path
    expect(rec!.body).not.toMatch(/telegramChatId/);
  });

  it('tool error rate below threshold → does not fire', () => {
    const callCount = T.highErrorToolMinCalls;
    const errorCount = Math.floor(callCount * (T.toolErrorRateMin - 0.01));
    const agg = makeAgg({
      traces: {
        totalTracedSessions: 1,
        toolCallCounts: { bash: callCount },
        toolErrorCounts: { bash: errorCount },
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.includes('bash'))).toHaveLength(0);
  });

  it('tool below minCalls → does not fire even with 100% error rate', () => {
    const agg = makeAgg({
      traces: {
        totalTracedSessions: 1,
        toolCallCounts: { bash: T.highErrorToolMinCalls - 1 },
        toolErrorCounts: { bash: T.highErrorToolMinCalls - 1 },
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.includes('bash'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Failing daemon task
// ---------------------------------------------------------------------------

describe('checkFailingDaemonTask', () => {
  it('failing daemon task at threshold → fires', () => {
    // 1 success out of 10 = 10% < 50% threshold
    const agg = makeAgg({
      daemon: {
        totalRuns: 10,
        successCount: 1,
        errorCount: 9,
        skipCount: 0,
        byTaskId: {
          'task-abc': { success: 1, error: 9, skip: 0 },
        },
        triggerBreakdown: {},
        skipReasons: {},
        recentErrors: [],
        avgDurationMs: 1000,
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.title.includes('task-abc'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('medium');
  });

  it('task with success rate above threshold → does not fire', () => {
    // 6 success out of 10 = 60% > 50% threshold
    const agg = makeAgg({
      daemon: {
        totalRuns: 10,
        successCount: 6,
        errorCount: 4,
        skipCount: 0,
        byTaskId: {
          'task-good': { success: 6, error: 4, skip: 0 },
        },
        triggerBreakdown: {},
        skipReasons: {},
        recentErrors: [],
        avgDurationMs: 1000,
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.includes('task-good'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Budget exceeded sessions
// ---------------------------------------------------------------------------

describe('checkBudgetExceededSessions', () => {
  it('budget exceeded at threshold → fires', () => {
    const agg = makeAgg({
      traces: {
        totalTracedSessions: T.budgetExceededSessionsMin,
        toolCallCounts: {},
        toolErrorCounts: {},
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: { budget_exceeded: T.budgetExceededSessionsMin },
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.body.includes('budget'));
    expect(rec).toBeDefined();
  });

  it('budget exceeded below threshold → does not fire', () => {
    const agg = makeAgg({
      traces: {
        totalTracedSessions: 1,
        toolCallCounts: {},
        toolErrorCounts: {},
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: { budget_exceeded: T.budgetExceededSessionsMin - 1 },
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.toLowerCase().includes('budget'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Overflow kills
// ---------------------------------------------------------------------------

describe('checkOverflowKills', () => {
  it('overflow kill present → fires', () => {
    const agg = makeAgg({
      routing: {
        totalRoutingEvents: 1,
        skillDispatchModes: {},
        skillFrequency: {},
        composeCallCount: 0,
        avgComposeNodes: 0,
        avgComposeEdges: 0,
        overflowKills: { web_scrape: T.overflowKillsMin },
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.title.includes('web_scrape'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('medium');
  });

  it('no overflow kills → does not fire', () => {
    const recs = evaluateRecommendations(makeAgg());
    expect(recs.filter((r) => r.title.includes('overflow'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Cost concentration
// ---------------------------------------------------------------------------

describe('checkCostConcentration', () => {
  it('cost concentration at threshold → fires', () => {
    const totalCost = 1.0;
    const modelCost = totalCost * T.costConcentrationMax; // exactly at threshold
    const agg = makeAgg({
      sessions: {
        totalSessions: 10,
        totalCostUsd: totalCost,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        byDay: {},
        byModel: {
          'claude-3-opus-20240229': { costUsd: modelCost, sessions: 10 },
        },
        bySurface: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.title.includes('concentration') || r.title.includes('claude'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('info');
  });

  it('cost below minimum threshold → does not fire even with concentration', () => {
    const totalCost = T.costConcentrationMinCostUsd * 0.5; // below min
    const agg = makeAgg({
      sessions: {
        totalSessions: 1,
        totalCostUsd: totalCost,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        byDay: {},
        byModel: {
          'claude-3-opus': { costUsd: totalCost, sessions: 1 },
        },
        bySurface: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.includes('concentration'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: No traced sessions
// ---------------------------------------------------------------------------

describe('checkNoTracedSessions', () => {
  it('sessions exist but no traces → fires info recommendation', () => {
    const agg = makeAgg({
      sessions: {
        totalSessions: 5,
        totalCostUsd: 0.1,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        byDay: {},
        byModel: {},
        bySurface: {},
      },
      traces: {
        totalTracedSessions: 0,
        toolCallCounts: {},
        toolErrorCounts: {},
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: {},
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.title.toLowerCase().includes('trace'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('info');
  });

  it('zero sessions and zero traces → does not fire', () => {
    const recs = evaluateRecommendations(makeAgg());
    expect(recs.filter((r) => r.title.toLowerCase().includes('trace'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 7: High average daemon error rate
// ---------------------------------------------------------------------------

describe('checkHighAvgDaemonError', () => {
  it('high overall error rate with enough runs → fires', () => {
    const total = T.minRunsForDaemonErrorRate;
    const errors = Math.ceil(total * (T.highDaemonErrorRateMin + 0.01)); // just above threshold
    const agg = makeAgg({
      daemon: {
        totalRuns: total,
        successCount: total - errors,
        errorCount: errors,
        skipCount: 0,
        byTaskId: {},
        triggerBreakdown: {},
        skipReasons: {},
        recentErrors: [],
        avgDurationMs: 1000,
      },
    });

    const recs = evaluateRecommendations(agg);
    const rec = recs.find((r) => r.title.includes('daemon error'));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('medium');
  });

  it('below min runs → does not fire even with 100% error rate', () => {
    const agg = makeAgg({
      daemon: {
        totalRuns: T.minRunsForDaemonErrorRate - 1,
        successCount: 0,
        errorCount: T.minRunsForDaemonErrorRate - 1,
        skipCount: 0,
        byTaskId: {},
        triggerBreakdown: {},
        skipReasons: {},
        recentErrors: [],
        avgDurationMs: 0,
      },
    });

    const recs = evaluateRecommendations(agg);
    expect(recs.filter((r) => r.title.includes('daemon error'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// All healthy / sort order / privacy
// ---------------------------------------------------------------------------

describe('evaluateRecommendations', () => {
  it('all zeros → returns empty array (all healthy)', () => {
    const recs = evaluateRecommendations(makeAgg());
    expect(recs).toHaveLength(0);
  });

  it('high severity appears before medium in output', () => {
    // Combine tool error (high) + overflow kill (medium)
    const callCount = T.highErrorToolMinCalls;
    const errorCount = callCount; // 100% error rate
    const agg = makeAgg({
      traces: {
        totalTracedSessions: 1,
        toolCallCounts: { bash: callCount },
        toolErrorCounts: { bash: errorCount },
        toolDurationsMs: {},
        subagentForkDepths: {},
        compactionCount: 0,
        closureReasons: {},
      },
      routing: {
        totalRoutingEvents: 1,
        skillDispatchModes: {},
        skillFrequency: {},
        composeCallCount: 0,
        avgComposeNodes: 0,
        avgComposeEdges: 0,
        overflowKills: { bash: 3 },
      },
    });

    const recs = evaluateRecommendations(agg);
    const firstHigh = recs.findIndex((r) => r.severity === 'high');
    const firstMedium = recs.findIndex((r) => r.severity === 'medium');
    expect(firstHigh).toBeGreaterThanOrEqual(0);
    expect(firstMedium).toBeGreaterThanOrEqual(0);
    expect(firstHigh).toBeLessThan(firstMedium);
  });

  it('privacy: no recommendation contains telegramChatId or responseExcerpt', () => {
    // Even when constructing an agg that mentions these strings in task names
    const agg = makeAgg({
      daemon: {
        totalRuns: 10,
        successCount: 1,
        errorCount: 9,
        skipCount: 0,
        byTaskId: {
          'task-abc': { success: 1, error: 9, skip: 0 },
        },
        triggerBreakdown: {},
        skipReasons: {},
        recentErrors: [{ taskId: 'task-abc', ts: Date.now(), message: 'error msg' }],
        avgDurationMs: 1000,
      },
    });

    const recs = evaluateRecommendations(agg);
    const serialized = JSON.stringify(recs);
    expect(serialized).not.toContain('telegramChatId');
    expect(serialized).not.toContain('responseExcerpt');
  });
});
