/**
 * Traces aggregator — uses session facets as the primary session-level query
 * surface. Iterates session sidecars via `listSessionIds()` + `getOrDeriveFacet()`
 * for tool counts, error rates, and subagent depths. Falls back to trace JSONL
 * for cost/tokens/compaction/closure/durations (data not in facets).
 *
 * Privacy invariants:
 *   - `responseExcerpt`, prompt content, and user data are NEVER read or
 *     forwarded. We only parse structural metadata fields.
 *   - Line parsing uses Zod schemas from trace/events.ts. Unknown fields
 *     are ignored by the schema — they never reach output aggregates.
 *
 * Session filtering: the sidecar's `facet.start_time` is the window filter.
 * Sessions without sidecars are not counted (no trace-only enumeration).
 *
 * @module insights/aggregators/traces
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAfkStateDir, getFacetCacheDir } from '../../paths.js';
import { TraceEventSchema } from '../../agent/trace/events.js';
import { listSessionIds, getOrDeriveFacet } from '../../agent/facets/index.js';
import type { InsightsOptions, TraceAggregates } from '../types.js';
import { parseJsonlLines } from '../../utils/jsonl.js';

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroTraceAggregates(): TraceAggregates {
  return {
    totalTracedSessions: 0,
    toolCallCounts: {},
    toolErrorCounts: {},
    toolDurationsMs: {},
    subagentForkDepths: {},
    compactionCount: 0,
    closureReasons: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    sessionsWithCost: 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: increment a numeric record entry
// ---------------------------------------------------------------------------

function inc(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function incNum(rec: Record<number, number>, key: number, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate session metrics via facets (primary) + trace JSONL (fallback).
 *
 * Facet path: tool counts, error categories, subagent fork depths.
 * Trace path: cost, token splits, compaction counts, closure reasons, durations.
 * Never throws.
 */
export function aggregateTraces(options: InsightsOptions): TraceAggregates {
  const agg = zeroTraceAggregates();

  const stateDir = options.afkHome
    ? join(options.afkHome, 'state')
    : getAfkStateDir();
  const witnessRoot = join(stateDir, 'witness');
  const sessionsDir = join(stateDir, 'sessions');
  const cacheDir = options.afkHome ? join(options.afkHome, 'agent-framework', 'facets') : getFacetCacheDir();

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;

  // --- Primary path: iterate session sidecars via facets ---
  const sessionIds = listSessionIds({ sessionsDir });
  for (const sessionId of sessionIds) {
    const facet = getOrDeriveFacet(sessionId, { sessionsDir, cacheDir });
    if (!facet) continue;
    if (new Date(facet.start_time).getTime() < cutoffMs) continue;

    agg.totalTracedSessions += 1;

    for (const [tool, count] of Object.entries(facet.tool_counts)) {
      inc(agg.toolCallCounts, tool, count);
    }
    for (const [tool, count] of Object.entries(facet.tool_error_categories)) {
      inc(agg.toolErrorCounts, tool, count);
    }
    if (facet.subagents.length > 0) {
      // History: depth > 1 was never computed (parentId chains not tracked).
      // Key 1 is the flat direct-child invocation count, not a depth bucket.
      incNum(agg.subagentForkDepths, 1, facet.subagents.length);
    }

    // --- Fallback: trace.jsonl for cost/tokens/compaction/closure/durations ---
    // toolCallCounts and toolErrorCounts come ONLY from the facet above.
    // The trace path only writes: toolDurationsMs, compactionCount,
    // closureReasons, totalInputTokens, totalOutputTokens, totalCacheReadTokens,
    // totalCacheCreationTokens, totalCostUsd, sessionsWithCost.
    const traceSessionId = facet.session_id;
    const tracePath = join(witnessRoot, traceSessionId, 'trace.jsonl');
    if (!existsSync(tracePath)) continue;
    let raw: string | null = null;
    try {
      raw = readFileSync(tracePath, 'utf-8');
    } catch {
      continue;
    }
    if (!raw) continue;

    for (const parsed of parseJsonlLines(raw)) {
      const result = TraceEventSchema.safeParse(parsed);
      if (!result.success) continue;
      const event = result.data;

      switch (event.kind) {
        case 'compaction':
          agg.compactionCount += 1;
          break;

        case 'closure': {
          const { payload } = event;
          inc(agg.closureReasons, payload.reason);
          const ft = payload.finalTokens;
          agg.totalInputTokens += ft.input ?? 0;
          agg.totalOutputTokens += ft.output ?? 0;
          agg.totalCacheReadTokens += ft.cacheRead ?? 0;
          agg.totalCacheCreationTokens += ft.cacheCreation ?? 0;
          agg.totalCostUsd += payload.finalCostUsd;
          if (payload.finalCostUsd > 0) agg.sessionsWithCost += 1;
          break;
        }

        case 'tool_call': {
          // Only accumulate durations here — counts come from facet to avoid
          // double-counting.
          if (event.payload.phase === 'completed' && !event.payload.isError) {
            inc(agg.toolDurationsMs, event.payload.name, event.payload.durationMs);
          }
          break;
        }

        default:
          break;
      }
    }
  }

  return agg;
}
