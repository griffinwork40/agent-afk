/**
 * Subagent outcome aggregator — joins `subagent.dispatched` + outcome rows
 * (`subagent.completed` / `subagent.failed`) from routing-decisions.jsonl by
 * subagent id, then buckets each completed subagent by:
 *
 *   model × agentType × depth
 *
 * For each bucket it computes success rate, cap-hit rate, timeout rate, and
 * p50/p95 latency. Depth > 1 is computed by walking the `parent_session_id`
 * chain (dispatch row) against the parentId set built from started events in
 * the routing stream. Rows without a `resolved_agent_type` are bucketed under
 * a synthetic `"unnamed"` type.
 *
 * Privacy invariants:
 *   - No prompt content, no session IDs in aggregate output.
 *   - Only operational metadata fields are accessed:
 *     model, resolved_agent_type, status, duration_ms, stop_reason, depth,
 *     subagent_id, parent_session_id, ts.
 *
 * @module insights/aggregators/subagent-outcomes
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRoutingDecisionsPath } from '../../paths.js';
import { readTailMb } from './daemon.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { InsightsOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome statistics for one model × agentType × depth bucket.
 *
 * Rates are expressed as fractions (0–1). `count` is the number of completed
 * or failed outcomes for this bucket (dispatched-only rows without a matching
 * outcome row are excluded from all rate/latency stats but counted separately
 * in `SubagentOutcomeAggregates.dispatchedCount`).
 */
export interface SubagentOutcomeBucket {
  /** Total outcome rows in this bucket (succeeded + failed). */
  count: number;
  /** Fraction of succeeded outcomes (0–1). */
  successRate: number;
  /**
   * Fraction of outcomes whose stop_reason is `tool_use_loop_capped` (0–1).
   * A high cap-hit rate at a given budget is the primary signal to either
   * raise `maxToolUseIterations` or route to a cheaper/lighter agent type.
   */
  capHitRate: number;
  /**
   * Fraction of outcomes whose stop_reason contains `timeout` or whose status
   * is `timeout` (0–1).
   */
  timeoutRate: number;
  /** p50 latency in ms across outcomes in this bucket. 0 when no data. */
  p50Ms: number;
  /** p95 latency in ms across outcomes in this bucket. 0 when no data. */
  p95Ms: number;
}

/** Full subagent-outcome aggregate. */
export interface SubagentOutcomeAggregates {
  /**
   * Nested map: model → agentType → depth → bucket.
   *
   * The `agentType` key is the `resolved_agent_type` from the dispatch row,
   * or `"unnamed"` when absent (bare/compose/skill forks without a named
   * type). The `depth` key is a numeric string (`"1"`, `"2"`, …) from the
   * routing row's `depth` field (or `"1"` when absent).
   */
  byModelTypeDepth: Record<string, Record<string, Record<string, SubagentOutcomeBucket>>>;
  /**
   * Total dispatch rows observed in the window (regardless of whether the
   * corresponding outcome row was also in the window).
   */
  dispatchedCount: number;
  /**
   * Total outcome rows (succeeded + failed) observed in the window. A row is
   * counted here only when it could be joined to a dispatch row by subagent_id.
   */
  outcomeCount: number;
  /** Rows skipped due to parse errors. */
  parseErrors: number;
}

// ---------------------------------------------------------------------------
// Zero factory
// ---------------------------------------------------------------------------

export function zeroSubagentOutcomeAggregates(): SubagentOutcomeAggregates {
  return {
    byModelTypeDepth: {},
    dispatchedCount: 0,
    outcomeCount: 0,
    parseErrors: 0,
  };
}

function zeroBucket(): { durations: number[]; capHits: number; timeouts: number; successes: number; count: number } {
  return { durations: [], capHits: 0, timeouts: 0, successes: 0, count: 0 };
}

// ---------------------------------------------------------------------------
// Percentile helper (in-place sort; mutates the array)
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

// ---------------------------------------------------------------------------
// Internal accumulator types
// ---------------------------------------------------------------------------

interface DispatchRow {
  model: string;
  agentType: string;
  depth: number;
}

interface OutcomeRow {
  status: string;
  durationMs: number;
  stopReason: string;
}

type BucketAcc = ReturnType<typeof zeroBucket>;

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Parse routing-decisions.jsonl and return aggregated subagent outcome metrics
 * bucketed by model × agentType × depth.
 *
 * Never throws. Returns zero aggregates when the file is missing or empty.
 */
export function aggregateSubagentOutcomes(
  options: InsightsOptions,
): SubagentOutcomeAggregates {
  const agg = zeroSubagentOutcomeAggregates();

  const routingPath = options.afkHome
    ? join(options.afkHome, 'agent-framework', 'routing-decisions.jsonl')
    : getRoutingDecisionsPath();

  if (!existsSync(routingPath)) return agg;

  let rawContent: string;
  try {
    rawContent = readTailMb(routingPath);
  } catch {
    return agg;
  }

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;

  // --- Pass 1: collect dispatch and outcome rows ---
  const dispatched = new Map<string, DispatchRow>();
  const outcomes = new Map<string, OutcomeRow>();

  const records = parseJsonlLines<Record<string, unknown>>(rawContent, {
    guard: (x): x is Record<string, unknown> =>
      x !== null && typeof x === 'object' && !Array.isArray(x),
  });

  for (const record of records) {
    // Window filter
    const tsRaw = record['ts'];
    if (typeof tsRaw !== 'string') continue;
    const tsMs = Date.parse(tsRaw);
    if (Number.isNaN(tsMs) || tsMs < cutoffMs) continue;

    const event = typeof record['event'] === 'string' ? record['event'] : null;
    if (!event) continue;

    if (event === 'subagent.dispatched') {
      const subagentId = typeof record['subagent_id'] === 'string' ? record['subagent_id'] : null;
      if (!subagentId) continue;

      const model = typeof record['model'] === 'string' && record['model'] !== ''
        ? record['model']
        : 'unknown';
      const agentType = typeof record['resolved_agent_type'] === 'string' && record['resolved_agent_type'] !== ''
        ? record['resolved_agent_type']
        : 'unnamed';
      const depth = typeof record['depth'] === 'number' && Number.isFinite(record['depth'])
        ? Math.max(1, Math.round(record['depth']))
        : 1;

      dispatched.set(subagentId, { model, agentType, depth });
      agg.dispatchedCount += 1;
    } else if (event === 'subagent.completed' || event === 'subagent.failed') {
      const subagentId = typeof record['subagent_id'] === 'string' ? record['subagent_id'] : null;
      if (!subagentId) continue;

      const status = typeof record['status'] === 'string' ? record['status'] : 'unknown';
      const durationMs = typeof record['duration_ms'] === 'number' && Number.isFinite(record['duration_ms'])
        ? record['duration_ms']
        : 0;
      const stopReason = typeof record['stop_reason'] === 'string' ? record['stop_reason'] : '';

      outcomes.set(subagentId, { status, durationMs, stopReason });
    }
  }

  // --- Pass 2: join dispatch + outcome, bucket ---

  // bucket key: `${model}\x00${agentType}\x00${depth}`
  const buckets = new Map<string, BucketAcc>();

  for (const [subagentId, dispatch] of dispatched) {
    const outcome = outcomes.get(subagentId);
    if (!outcome) continue; // no outcome row in this window — skip from rate/latency stats

    agg.outcomeCount += 1;

    const { model, agentType, depth } = dispatch;
    const { status, durationMs, stopReason } = outcome;

    // Ensure nested path exists in output map
    (agg.byModelTypeDepth[model] ??= {});
    (agg.byModelTypeDepth[model]![agentType] ??= {});
    const depthKey = String(depth);

    const bucketKey = `${model}\x00${agentType}\x00${depthKey}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = zeroBucket();
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    if (status === 'succeeded') bucket.successes += 1;
    if (stopReason === 'tool_use_loop_capped') bucket.capHits += 1;
    if (stopReason.includes('timeout') || status === 'timeout') bucket.timeouts += 1;
    if (durationMs > 0) bucket.durations.push(durationMs);
  }

  // --- Pass 3: compute rates and percentiles ---
  for (const [bucketKey, acc] of buckets) {
    const parts = bucketKey.split('\x00');
    const model = parts[0] ?? 'unknown';
    const agentType = parts[1] ?? 'unnamed';
    const depthKey = parts[2] ?? '1';

    const sorted = [...acc.durations].sort((a, b) => a - b);
    const n = acc.count;

    const bucket: SubagentOutcomeBucket = {
      count: n,
      successRate: n > 0 ? acc.successes / n : 0,
      capHitRate: n > 0 ? acc.capHits / n : 0,
      timeoutRate: n > 0 ? acc.timeouts / n : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
    };

    (agg.byModelTypeDepth[model] ??= {});
    (agg.byModelTypeDepth[model]![agentType] ??= {});
    agg.byModelTypeDepth[model]![agentType]![depthKey] = bucket;
  }

  return agg;
}

// ---------------------------------------------------------------------------
// Compact summary for get_runtime_state
// ---------------------------------------------------------------------------

/**
 * One line of the compact summary emitted to `get_runtime_state`.
 *
 * Format: `"<model> <agentType> depth <depth>: <successPct>% ok, <capPct>% capped, <count> runs"`
 *
 * Only buckets with `count >= minCount` are included so the summary stays
 * actionable (sparse buckets with 1–2 samples are noisy).
 */
export interface SubagentOutcomeSummaryEntry {
  model: string;
  agentType: string;
  depth: number;
  count: number;
  successRate: number;
  capHitRate: number;
  p50Ms: number;
}

/**
 * Build a compact flat list from the full aggregate. Sorted by count descending
 * (busiest buckets first) so the model sees the most data-rich entries first.
 *
 * @param agg - Full aggregate from `aggregateSubagentOutcomes`.
 * @param minCount - Minimum count to include a bucket (default 3).
 */
export function buildSubagentOutcomeSummary(
  agg: SubagentOutcomeAggregates,
  minCount = 3,
): SubagentOutcomeSummaryEntry[] {
  const entries: SubagentOutcomeSummaryEntry[] = [];

  for (const [model, byType] of Object.entries(agg.byModelTypeDepth)) {
    for (const [agentType, byDepth] of Object.entries(byType)) {
      for (const [depthKey, bucket] of Object.entries(byDepth)) {
        if (bucket.count < minCount) continue;
        entries.push({
          model,
          agentType,
          depth: parseInt(depthKey, 10) || 1,
          count: bucket.count,
          successRate: bucket.successRate,
          capHitRate: bucket.capHitRate,
          p50Ms: bucket.p50Ms,
        });
      }
    }
  }

  return entries.sort((a, b) => b.count - a.count);
}
