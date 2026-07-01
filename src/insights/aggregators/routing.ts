/**
 * Routing decisions aggregator — reads routing-decisions.jsonl and aggregates
 * skill dispatch modes, skill frequency, compose call counts, and overflow kills.
 *
 * Privacy invariants:
 *   - Only `event`, `mode`, `tool`, `node_count`, `edge_count` operational
 *     fields are used. No prompt content, no user data.
 *   - Unknown fields are ignored.
 *
 * Note: routing decisions don't have consistent timestamps in all records, so
 * this aggregator aggregates ALL records in the file (no `--days` window filter).
 *
 * @module insights/aggregators/routing
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRoutingDecisionsPath } from '../../paths.js';
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
    rawContent = readFileSync(routingPath, 'utf-8');
  } catch {
    return agg;
  }

  const lines = rawContent.split('\n');

  let totalComposeNodes = 0;
  let totalComposeEdges = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // malformed line — skip
    }

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
      if (event === 'compose.started' || event === 'compose.completed') {
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
