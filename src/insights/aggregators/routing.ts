/**
 * Routing decisions aggregator — reads routing-decisions.jsonl and aggregates
 * skill dispatch modes, skill frequency, compose call counts, and overflow kills.
 *
 * Privacy invariants:
 *   - Only `event`, `mode`, `tool`, `node_count`, `edge_count` operational
 *     fields are used. No prompt content, no user data.
 *   - Unknown fields are ignored.
 *
 * Note: `appendRoutingDecision` (see `agent/routing-telemetry.ts`) stamps
 * every record with a `ts` ISO-8601 field at write time, so this aggregator
 * applies the same `--days` window filter as the other aggregators (see
 * `daemon.ts`'s `triggeredAt` handling): records missing/with an unparseable
 * `ts`, or older than the window, are skipped.
 *
 * @module insights/aggregators/routing
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRoutingDecisionsPath } from '../../paths.js';
import { readTailMb } from './daemon.js';
import type { InsightsOptions, RoutingAggregates } from '../types.js';

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroRoutingAggregates(): RoutingAggregates {
  return {
    totalRoutingEvents: 0,
    skillDispatchModes: {},
    skillFrequency: {},
    composeCallCount: 0,
    avgComposeNodes: 0,
    avgComposeEdges: 0,
    overflowKills: {},
  };
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Parse `routing-decisions.jsonl` and return aggregated routing metrics.
 * Never throws — returns zero aggregates when the file is missing or empty.
 */
export function aggregateRoutingDecisions(options: InsightsOptions): RoutingAggregates {
  const agg = zeroRoutingAggregates();

  // Determine file path — use afkHome override for tests.
  const routingPath = options.afkHome
    ? join(options.afkHome, 'agent-framework', 'routing-decisions.jsonl')
    : getRoutingDecisionsPath();

  if (!existsSync(routingPath)) {
    return agg;
  }

  let rawContent: string;
  try {
    // Bounded tail read (same 1 MB cap as daemon.ts) — routing-decisions.jsonl
    // can grow unbounded over time, and we only need records inside the
    // `--days` window anyway.
    rawContent = readTailMb(routingPath);
  } catch {
    return agg;
  }

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const lines = rawContent.split('\n');

  let totalComposeNodes = 0;
  let totalComposeEdges = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip
    }
    // A valid-JSON-but-non-object line (bare `null`, a number, a string, an
    // array) parses cleanly and escapes the catch above. Skip it before any
    // property access so `null['event']` can never throw.
    if (parsed === null || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;

    // Filter by the `ts` field every record carries (see appendRoutingDecision
    // in agent/routing-telemetry.ts). Missing/unparseable timestamps are
    // treated as out-of-window, consistent with daemon.ts's triggeredAt check.
    const tsRaw = record['ts'];
    if (typeof tsRaw !== 'string') continue;
    const tsMs = Date.parse(tsRaw);
    if (Number.isNaN(tsMs) || tsMs < cutoffMs) continue;

    const event = typeof record['event'] === 'string' ? record['event'] : null;
    if (!event) continue;

    agg.totalRoutingEvents += 1;

    // skill.dispatched — skill dispatch mode breakdown
    if (event === 'skill.dispatched') {
      const mode = typeof record['mode'] === 'string' ? record['mode'] : 'unknown';
      agg.skillDispatchModes[mode] = (agg.skillDispatchModes[mode] ?? 0) + 1;

      // Skill name frequency — could be stored in various fields
      const skillName =
        typeof record['requested_name'] === 'string' ? record['requested_name']
        : typeof record['skill_name'] === 'string' ? record['skill_name']
        : null;
      if (skillName) {
        agg.skillFrequency[skillName] = (agg.skillFrequency[skillName] ?? 0) + 1;
      }
    }

    // tool.overflow_kill — overflow kill breakdown by tool
    else if (event === 'tool.overflow_kill') {
      const tool = typeof record['tool'] === 'string' ? record['tool'] : 'unknown';
      agg.overflowKills[tool] = (agg.overflowKills[tool] ?? 0) + 1;
    }

    // compose.* events — compose call stats
    else if (event.startsWith('compose.')) {
      // Count each compose call exactly once. Production emits BOTH
      // `compose.started` (always, once per call) and `compose.completed`
      // (on completion), each carrying node_count/edge_count — counting both
      // would report ~2x the real call count. `compose.started` is the
      // authoritative per-call signal.
      if (event === 'compose.started') {
        agg.composeCallCount += 1;
        const nodeCount = typeof record['node_count'] === 'number' ? record['node_count'] : 0;
        const edgeCount = typeof record['edge_count'] === 'number' ? record['edge_count'] : 0;
        totalComposeNodes += nodeCount;
        totalComposeEdges += edgeCount;
      }
    }
  }

  // Compute averages
  agg.avgComposeNodes =
    agg.composeCallCount > 0 ? totalComposeNodes / agg.composeCallCount : 0;
  agg.avgComposeEdges =
    agg.composeCallCount > 0 ? totalComposeEdges / agg.composeCallCount : 0;

  return agg;
}
