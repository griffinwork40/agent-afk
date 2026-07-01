/**
 * Barrel: aggregates all four data sources and merges into `InsightAggregates`.
 *
 * Each individual aggregator is wrapped in `Promise.allSettled` so a failure
 * in one source (e.g. corrupt JSONL) returns a zero-aggregate for that slice
 * without affecting the others.
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
export async function aggregateAll(options: InsightsOptions): Promise<InsightAggregates> {
  const [sessionsResult, tracesResult, daemonResult, routingResult] =
    await Promise.allSettled([
      Promise.resolve(aggregateSessions(options)),
      Promise.resolve(aggregateTraces(options)),
      Promise.resolve(aggregateDaemonTelemetry(options)),
      Promise.resolve(aggregateRoutingDecisions(options)),
    ]);

  return {
    generatedAt: Date.now(),
    windowDays: options.days,
    sessions:
      sessionsResult.status === 'fulfilled'
        ? sessionsResult.value
        : zeroSessionAggregates(),
    traces:
      tracesResult.status === 'fulfilled'
        ? tracesResult.value
        : zeroTraceAggregates(),
    daemon:
      daemonResult.status === 'fulfilled'
        ? daemonResult.value
        : zeroDaemonAggregates(),
    routing:
      routingResult.status === 'fulfilled'
        ? routingResult.value
        : zeroRoutingAggregates(),
  };
}
