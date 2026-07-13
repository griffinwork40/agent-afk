/**
 * Unit tests for the routing decisions aggregator.
 *
 * Strategy: synthetic temp-dir fixtures with controlled JSONL content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateRoutingDecisions } from './routing.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'agent-framework'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRouting(lines: string[]): void {
  writeFileSync(
    join(tmpRoot, 'agent-framework', 'routing-decisions.jsonl'),
    lines.join('\n') + '\n',
    'utf-8',
  );
}

function skillDispatched(mode: string, skillName?: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    event: 'skill.dispatched',
    surface: 'afk',
    mode,
    ...(skillName ? { requested_name: skillName } : {}),
  });
}

function overflowKill(tool: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    event: 'tool.overflow_kill',
    surface: 'afk',
    tool,
    total_bytes: 1_200_000,
  });
}

function composeStarted(nodeCount: number, edgeCount: number): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    event: 'compose.started',
    surface: 'afk',
    node_count: nodeCount,
    edge_count: edgeCount,
  });
}

function composeCompleted(nodeCount: number, edgeCount: number): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    event: 'compose.completed',
    surface: 'afk',
    node_count: nodeCount,
    edge_count: edgeCount,
    succeeded: nodeCount,
    failed: 0,
    skipped: 0,
    duration_ms: 1234,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateRoutingDecisions', () => {
  it('missing routing-decisions.jsonl → zero aggregates, no throw', () => {
    const result = aggregateRoutingDecisions({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result.totalRoutingEvents).toBe(0);
    expect(result.composeCallCount).toBe(0);
    expect(Object.keys(result.skillDispatchModes)).toHaveLength(0);
    expect(Object.keys(result.overflowKills)).toHaveLength(0);
  });

  it('zero aggregates when file does not exist', () => {
    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.totalRoutingEvents).toBe(0);
  });

  it('skill.dispatched fork → fork count incremented', () => {
    writeRouting([skillDispatched('fork')]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['fork']).toBe(1);
  });

  it('skill.dispatched inline → inline count incremented', () => {
    writeRouting([skillDispatched('inline')]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['inline']).toBe(1);
  });

  it('skill.dispatched load → load count incremented', () => {
    writeRouting([skillDispatched('load')]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['load']).toBe(1);
  });

  it('multiple skill dispatch modes accumulated', () => {
    writeRouting([
      skillDispatched('fork'),
      skillDispatched('fork'),
      skillDispatched('inline'),
      skillDispatched('load'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['fork']).toBe(2);
    expect(result.skillDispatchModes['inline']).toBe(1);
    expect(result.skillDispatchModes['load']).toBe(1);
  });

  it('skill name frequency accumulated', () => {
    writeRouting([
      skillDispatched('fork', 'forge'),
      skillDispatched('fork', 'forge'),
      skillDispatched('inline', 'improve'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillFrequency['forge']).toBe(2);
    expect(result.skillFrequency['improve']).toBe(1);
  });

  it('tool.overflow_kill web_scrape → overflowKills[web_scrape] incremented', () => {
    writeRouting([overflowKill('web_scrape')]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.overflowKills['web_scrape']).toBe(1);
  });

  it('multiple overflow kills on same tool accumulated', () => {
    writeRouting([
      overflowKill('web_scrape'),
      overflowKill('web_scrape'),
      overflowKill('bash'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.overflowKills['web_scrape']).toBe(2);
    expect(result.overflowKills['bash']).toBe(1);
  });

  it('compose.started event → composeCallCount and node/edge accumulation', () => {
    writeRouting([composeStarted(5, 4)]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.composeCallCount).toBe(1);
    expect(result.avgComposeNodes).toBeCloseTo(5);
    expect(result.avgComposeEdges).toBeCloseTo(4);
  });

  it('avg compose nodes computed correctly across multiple compose events', () => {
    writeRouting([
      composeStarted(4, 3),
      composeStarted(6, 5),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.composeCallCount).toBe(2);
    expect(result.avgComposeNodes).toBeCloseTo(5); // (4+6)/2
    expect(result.avgComposeEdges).toBeCloseTo(4); // (3+5)/2
  });

  it('compose.started + compose.completed for one call → counted once (no double-count)', () => {
    // Regression: production emits BOTH events per compose call. Counting both
    // would report 2 calls for 1 real call. compose.started is the sole call
    // signal; compose.completed still counts as a routing event.
    writeRouting([
      composeStarted(5, 4),
      composeCompleted(5, 4),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.composeCallCount).toBe(1);
    expect(result.avgComposeNodes).toBeCloseTo(5);
    expect(result.avgComposeEdges).toBeCloseTo(4);
    expect(result.totalRoutingEvents).toBe(2);
  });

  it('malformed line → skipped, no throw', () => {
    writeRouting([
      '{ not valid json }',
      skillDispatched('fork'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['fork']).toBe(1);
  });

  it('valid-JSON non-object lines (null, number, string, array) → skipped, no throw', () => {
    // Regression: these parse cleanly and escape the parse catch. Without the
    // null/object guard, a bare `null` line crashes on the first field access.
    writeRouting([
      'null',
      '42',
      '"just a string"',
      '[1, 2, 3]',
      skillDispatched('fork'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['fork']).toBe(1);
  });

  it('empty lines → skipped, no throw', () => {
    writeRouting([
      '',
      skillDispatched('fork'),
      '',
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.skillDispatchModes['fork']).toBe(1);
  });

  it('totalRoutingEvents counts all valid events', () => {
    writeRouting([
      skillDispatched('fork'),
      overflowKill('bash'),
      composeStarted(3, 2),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.totalRoutingEvents).toBe(3);
  });

  it('avgComposeNodes and avgComposeEdges are 0 when no compose events', () => {
    writeRouting([skillDispatched('fork')]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.avgComposeNodes).toBe(0);
    expect(result.avgComposeEdges).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1: --days window filter (every record carries a `ts` field — see
  // appendRoutingDecision in agent/routing-telemetry.ts)
  // -------------------------------------------------------------------------

  it('record dated outside the window is excluded at days:1; an in-window record is included', () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const recentTs = new Date().toISOString();
    writeRouting([
      JSON.stringify({
        ts: oldTs,
        event: 'skill.dispatched',
        surface: 'afk',
        mode: 'fork',
        requested_name: 'old-skill',
      }),
      JSON.stringify({
        ts: recentTs,
        event: 'skill.dispatched',
        surface: 'afk',
        mode: 'fork',
        requested_name: 'new-skill',
      }),
    ]);

    const result = aggregateRoutingDecisions({ days: 1, afkHome: tmpRoot });
    expect(result.totalRoutingEvents).toBe(1);
    expect(result.skillFrequency['new-skill']).toBe(1);
    expect(result.skillFrequency['old-skill']).toBeUndefined();
  });

  it('record missing `ts` is excluded (treated as out-of-window, consistent with daemon.ts)', () => {
    writeRouting([
      JSON.stringify({ event: 'skill.dispatched', surface: 'afk', mode: 'fork', requested_name: 'no-ts' }),
      skillDispatched('fork', 'has-ts'),
    ]);

    const result = aggregateRoutingDecisions({ days: 30, afkHome: tmpRoot });
    expect(result.totalRoutingEvents).toBe(1);
    expect(result.skillFrequency['has-ts']).toBe(1);
    expect(result.skillFrequency['no-ts']).toBeUndefined();
  });
});
