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
 *
 * The catch is never silent: a real failure emits a one-line stderr warning
 * naming `source` so it stays observable instead of looking identical to
 * "no data" in the rendered report. The never-throw contract (fallback
 * return) is preserved either way.
 */
function safeAggregate<T>(source: string, compute: () => T, fallback: () => T): T {
  try {
    return compute();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[insights] ${source} aggregator failed, using zero-aggregate: ${message}\n`);
    return fallback();
  }
}

export async function aggregateAll(options: InsightsOptions): Promise<InsightAggregates> {
  return {
    generatedAt: Date.now(),
    windowDays: options.days,
    sessions: safeAggregate('sessions', () => aggregateSessions(options), zeroSessionAggregates),
    traces: safeAggregate('traces', () => aggregateTraces(options), zeroTraceAggregates),
    daemon: safeAggregate('daemon', () => aggregateDaemonTelemetry(options), zeroDaemonAggregates),
    routing: safeAggregate('routing', () => aggregateRoutingDecisions(options), zeroRoutingAggregates),
  };
}
