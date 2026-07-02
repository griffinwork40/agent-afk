/**
 * Barrel: aggregates all four data sources and merges into `InsightAggregates`.
 *
 * Each aggregator is synchronous, so a failure in one source (e.g. an
 * unexpected throw on corrupt input) is contained by a per-source try/catch
 * that falls back to that slice's zero-aggregate. A `Promise.allSettled`
 * barrel cannot serve this role: the aggregators execute during synchronous
 * argument evaluation, so a throw escapes before `allSettled` can observe it.
 *
 * @module insights/aggregators/index
 */

import { aggregateSessions, zeroSessionAggregates } from './sessions.js';
import { aggregateTraces, zeroTraceAggregates } from './traces.js';
import { aggregateDaemonTelemetry, zeroDaemonAggregates } from './daemon.js';
import { aggregateRoutingDecisions, zeroRoutingAggregates } from './routing.js';
import type { InsightsOptions, InsightAggregates } from '../types.js';

export {
  aggregateSessions,
  aggregateTraces,
  aggregateDaemonTelemetry,
  aggregateRoutingDecisions,
};

/**
 * Aggregate all telemetry sources. Returns a complete `InsightAggregates`
 * even when some sources are missing or throw — those slices fall back to
 * zero-aggregates. Never throws.
 */
/**
 * Run a synchronous aggregator, falling back to its zero-aggregate if it
 * throws. The aggregators are written to never throw, but this is a hard
 * backstop so one unexpected failure can never break the whole report.
 */
function safeAggregate<T>(compute: () => T, fallback: () => T): T {
  try {
    return compute();
  } catch {
    return fallback();
  }
}

export async function aggregateAll(options: InsightsOptions): Promise<InsightAggregates> {
  return {
    generatedAt: Date.now(),
    windowDays: options.days,
    sessions: safeAggregate(() => aggregateSessions(options), zeroSessionAggregates),
    traces: safeAggregate(() => aggregateTraces(options), zeroTraceAggregates),
    daemon: safeAggregate(() => aggregateDaemonTelemetry(options), zeroDaemonAggregates),
    routing: safeAggregate(() => aggregateRoutingDecisions(options), zeroRoutingAggregates),
  };
}
