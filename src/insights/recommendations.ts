/**
 * Recommendation engine — pure function over `InsightAggregates`.
 *
 * Seven rule functions, each returning `Recommendation[]`. Rules read from
 * `RECOMMENDATION_THRESHOLDS` so all tunable values stay auditable.
 *
 * Invariants:
 *   - Zero I/O, zero LLM calls.
 *   - Recommendation `title` and `body` NEVER reference file paths,
 *     `telegramChatId`, or any prompt/response content.
 *   - Output sorted: 'high' before 'medium' before 'info', then by
 *     `metric` descending within the same severity.
 *
 * @module insights/recommendations
 */

import { RECOMMENDATION_THRESHOLDS as T } from './constants.js';
import type { InsightAggregates, Recommendation, RecommendationSeverity } from './types.js';

// ---------------------------------------------------------------------------
// Severity sort order helper
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<RecommendationSeverity, number> = {
  high: 0,
  medium: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// Rule 1: High tool error rate
// ---------------------------------------------------------------------------

function checkHighErrorRateTool(agg: InsightAggregates): Recommendation[] {
  const results: Recommendation[] = [];
  for (const [toolName, callCount] of Object.entries(agg.traces.toolCallCounts)) {
    if (callCount < T.highErrorToolMinCalls) continue;
    const errorCount = agg.traces.toolErrorCounts[toolName] ?? 0;
    const errorRate = errorCount / callCount;
    if (errorRate >= T.toolErrorRateMin) {
      results.push({
        severity: 'high',
        title: `High error rate on tool "${toolName}"`,
        body: `The tool "${toolName}" has a ${(errorRate * 100).toFixed(0)}% error rate over ${callCount} calls. Consider reviewing recent errors or reducing usage of this tool.`,
        metric: errorRate,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 2: Failing daemon task
// ---------------------------------------------------------------------------

function checkFailingDaemonTask(agg: InsightAggregates): Recommendation[] {
  const results: Recommendation[] = [];
  for (const [taskId, counts] of Object.entries(agg.daemon.byTaskId)) {
    const total = counts.success + counts.error + counts.skip;
    if (total === 0) continue;
    const successRate = counts.success / total;
    if (successRate < T.daemonSuccessRateMin) {
      results.push({
        severity: 'medium',
        title: `Low success rate for scheduled task "${taskId}"`,
        body: `Task "${taskId}" has only ${(successRate * 100).toFixed(0)}% success rate over ${total} runs. Check the task configuration and recent error logs.`,
        metric: successRate,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 3: Budget-exceeded sessions
// ---------------------------------------------------------------------------

function checkBudgetExceededSessions(agg: InsightAggregates): Recommendation[] {
  const count = agg.traces.closureReasons['budget_exceeded'] ?? 0;
  if (count >= T.budgetExceededSessionsMin) {
    return [
      {
        severity: 'medium',
        title: 'Frequent sessions hitting budget limit',
        body: `${count} sessions were closed because the cost budget was exceeded in the last ${agg.windowDays} days. Consider increasing your budget ceiling or breaking tasks into smaller scopes.`,
        metric: count,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 4: Overflow kills
// ---------------------------------------------------------------------------

function checkOverflowKills(agg: InsightAggregates): Recommendation[] {
  const results: Recommendation[] = [];
  for (const [toolName, killCount] of Object.entries(agg.routing.overflowKills)) {
    if (killCount >= T.overflowKillsMin) {
      results.push({
        severity: 'medium',
        title: `Output overflow kills on tool "${toolName}"`,
        body: `The tool "${toolName}" triggered ${killCount} output-size overflow kill(s). Consider adding result filters or using more targeted queries.`,
        metric: killCount,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rule 5: Cost concentration
// ---------------------------------------------------------------------------

function checkCostConcentration(agg: InsightAggregates): Recommendation[] {
  const totalCost = agg.sessions.totalCostUsd;
  if (totalCost <= T.costConcentrationMinCostUsd) return [];

  for (const [modelKey, data] of Object.entries(agg.sessions.byModel)) {
    const fraction = data.costUsd / totalCost;
    if (fraction >= T.costConcentrationMax) {
      return [
        {
          severity: 'info',
          title: `Cost concentrated on model "${modelKey}"`,
          body: `${(fraction * 100).toFixed(0)}% of total spend ($${totalCost.toFixed(2)}) is on "${modelKey}". Consider evaluating whether a less expensive model could handle some tasks.`,
          metric: fraction,
        },
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 6: No traced sessions
// ---------------------------------------------------------------------------

function checkNoTracedSessions(agg: InsightAggregates): Recommendation[] {
  if (agg.traces.totalTracedSessions === 0 && agg.sessions.totalSessions > 0) {
    return [
      {
        severity: 'info',
        title: 'No witness traces found for recent sessions',
        body: `${agg.sessions.totalSessions} sessions ran but none have witness traces. Trace data enables tool usage analytics. This may indicate the trace writer is disabled or sessions predated tracing.`,
        metric: agg.sessions.totalSessions,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 7: High average daemon error rate
// ---------------------------------------------------------------------------

function checkHighAvgDaemonError(agg: InsightAggregates): Recommendation[] {
  const total = agg.daemon.totalRuns;
  if (total < T.minRunsForDaemonErrorRate) return [];
  const errorRate = agg.daemon.errorCount / total;
  if (errorRate > T.highDaemonErrorRateMin) {
    return [
      {
        severity: 'medium',
        title: 'High overall daemon error rate',
        body: `${(errorRate * 100).toFixed(0)}% of daemon runs resulted in errors over the last ${agg.windowDays} days (${agg.daemon.errorCount} errors out of ${total} runs). Review your scheduled tasks and recent error messages.`,
        metric: errorRate,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate all recommendation rules against the given aggregates.
 * Returns a list of `Recommendation` objects sorted by severity (high → info),
 * then by `metric` descending within the same severity.
 *
 * Returns an empty array when all systems are healthy.
 * Never throws.
 */
export function evaluateRecommendations(agg: InsightAggregates): Recommendation[] {
  const all: Recommendation[] = [
    ...checkHighErrorRateTool(agg),
    ...checkFailingDaemonTask(agg),
    ...checkBudgetExceededSessions(agg),
    ...checkOverflowKills(agg),
    ...checkCostConcentration(agg),
    ...checkNoTracedSessions(agg),
    ...checkHighAvgDaemonError(agg),
  ];

  return all.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.metric - a.metric; // higher metric first within same severity
  });
}
