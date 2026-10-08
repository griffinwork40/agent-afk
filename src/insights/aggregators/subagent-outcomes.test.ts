/**
 * Unit tests for the subagent outcome aggregator.
 *
 * Strategy: synthetic temp-dir fixtures with controlled JSONL content.
 * Tests cover:
 *   - Missing file → zero aggregates, no throw
 *   - Single dispatched + completed row → correct bucket
 *   - Cap-hit rate from stop_reason='tool_use_loop_capped'
 *   - Timeout rate from stop_reason containing 'timeout'
 *   - Depth > 1 from the routing row's `depth` field
 *   - `unnamed` bucket when resolved_agent_type is absent
 *   - Outcome rows without a matching dispatch row are excluded
 *   - Dispatch rows without a matching outcome row excluded from rates/latency
 *   - p50/p95 percentile computation
 *   - Window filter (old records excluded)
 *   - buildSubagentOutcomeSummary minCount filter + sort
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateSubagentOutcomes,
  buildSubagentOutcomeSummary,
  zeroSubagentOutcomeAggregates,
} from './subagent-outcomes.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-subagent-outcomes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function now(): string {
  return new Date().toISOString();
}

function oldTs(): string {
  // 45 days ago — outside the 30-day default window
  return new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
}

function dispatched(opts: {
  id: string;
  model?: string;
  agentType?: string;
  depth?: number;
  ts?: string;
}): string {
  return JSON.stringify({
    ts: opts.ts ?? now(),
    event: 'subagent.dispatched',
    surface: 'afk',
    subagent_id: opts.id,
    model: opts.model ?? 'claude-sonnet-4-5',
    ...(opts.agentType ? { resolved_agent_type: opts.agentType } : {}),
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  });
}

function completed(opts: {
  id: string;
  status?: string;
  durationMs?: number;
  stopReason?: string;
  ts?: string;
}): string {
  return JSON.stringify({
    ts: opts.ts ?? now(),
    event: 'subagent.completed',
    surface: 'afk',
    subagent_id: opts.id,
    status: opts.status ?? 'succeeded',
    duration_ms: opts.durationMs ?? 1000,
    ...(opts.stopReason ? { stop_reason: opts.stopReason } : {}),
  });
}

function failed(opts: {
  id: string;
  status?: string;
  durationMs?: number;
  stopReason?: string;
  ts?: string;
}): string {
  return JSON.stringify({
    ts: opts.ts ?? now(),
    event: 'subagent.failed',
    surface: 'afk',
    subagent_id: opts.id,
    status: opts.status ?? 'failed',
    duration_ms: opts.durationMs ?? 500,
    ...(opts.stopReason ? { stop_reason: opts.stopReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateSubagentOutcomes', () => {
  it('missing routing-decisions.jsonl → zero aggregates, no throw', () => {
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result.dispatchedCount).toBe(0);
    expect(result.outcomeCount).toBe(0);
    expect(Object.keys(result.byModelTypeDepth)).toHaveLength(0);
  });

  it('empty file → zero aggregates', () => {
    writeRouting([]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.dispatchedCount).toBe(0);
    expect(result.outcomeCount).toBe(0);
  });

  it('single dispatch + completed → correct bucket', () => {
    writeRouting([
      dispatched({ id: 'sa-1', model: 'haiku', agentType: 'research-agent', depth: 1 }),
      completed({ id: 'sa-1', status: 'succeeded', durationMs: 2000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.dispatchedCount).toBe(1);
    expect(result.outcomeCount).toBe(1);

    const bucket = result.byModelTypeDepth['haiku']?.['research-agent']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    expect(bucket!.successRate).toBe(1);
    expect(bucket!.capHitRate).toBe(0);
    expect(bucket!.timeoutRate).toBe(0);
    expect(bucket!.p50Ms).toBe(2000);
    expect(bucket!.p95Ms).toBe(2000);
  });

  it('cap-hit rate when stop_reason is tool_use_loop_capped', () => {
    writeRouting([
      dispatched({ id: 'sa-1', model: 'sonnet', agentType: 'general-purpose', depth: 1 }),
      completed({ id: 'sa-1', status: 'succeeded', durationMs: 5000, stopReason: 'tool_use_loop_capped' }),
      dispatched({ id: 'sa-2', model: 'sonnet', agentType: 'general-purpose', depth: 1 }),
      completed({ id: 'sa-2', status: 'succeeded', durationMs: 3000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.outcomeCount).toBe(2);

    const bucket = result.byModelTypeDepth['sonnet']?.['general-purpose']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(2);
    expect(bucket!.capHitRate).toBe(0.5);
    expect(bucket!.successRate).toBe(1);
  });

  it('timeout rate when stop_reason contains timeout', () => {
    writeRouting([
      dispatched({ id: 'sa-1', model: 'haiku', agentType: 'Explore', depth: 1 }),
      completed({ id: 'sa-1', status: 'succeeded', durationMs: 1000, stopReason: 'soft_timeout' }),
      dispatched({ id: 'sa-2', model: 'haiku', agentType: 'Explore', depth: 1 }),
      completed({ id: 'sa-2', status: 'succeeded', durationMs: 2000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });

    const bucket = result.byModelTypeDepth['haiku']?.['Explore']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.timeoutRate).toBe(0.5);
  });

  it('failed outcome counts against success rate', () => {
    writeRouting([
      dispatched({ id: 'sa-1', model: 'sonnet', agentType: 'research-agent', depth: 1 }),
      failed({ id: 'sa-1', status: 'failed', durationMs: 800 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });

    const bucket = result.byModelTypeDepth['sonnet']?.['research-agent']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    expect(bucket!.successRate).toBe(0);
  });

  it('depth > 1 from the routing row depth field', () => {
    writeRouting([
      dispatched({ id: 'sa-deep', model: 'haiku', agentType: 'research-agent', depth: 2 }),
      completed({ id: 'sa-deep', status: 'succeeded', durationMs: 1500 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });

    // depth=2 bucket must exist
    const bucket2 = result.byModelTypeDepth['haiku']?.['research-agent']?.['2'];
    expect(bucket2).toBeDefined();
    expect(bucket2!.count).toBe(1);
    // depth=1 bucket must NOT exist
    const bucket1 = result.byModelTypeDepth['haiku']?.['research-agent']?.['1'];
    expect(bucket1).toBeUndefined();
  });

  it('unnamed bucket when resolved_agent_type is absent', () => {
    writeRouting([
      dispatched({ id: 'sa-bare', model: 'sonnet', depth: 1 }), // no agentType
      completed({ id: 'sa-bare', status: 'succeeded', durationMs: 1000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });

    const bucket = result.byModelTypeDepth['sonnet']?.['unnamed']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
  });

  it('outcome row without matching dispatch is excluded from outcomeCount', () => {
    // outcome row for an id that has no dispatch row
    writeRouting([
      completed({ id: 'orphan-1', status: 'succeeded', durationMs: 1000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.dispatchedCount).toBe(0);
    expect(result.outcomeCount).toBe(0);
    expect(Object.keys(result.byModelTypeDepth)).toHaveLength(0);
  });

  it('dispatch row without outcome row counted in dispatchedCount but not outcomeCount', () => {
    writeRouting([
      dispatched({ id: 'sa-noout', model: 'sonnet', agentType: 'research-agent', depth: 1 }),
      // no outcome row
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.dispatchedCount).toBe(1);
    expect(result.outcomeCount).toBe(0);
    expect(Object.keys(result.byModelTypeDepth)).toHaveLength(0);
  });

  it('p50 and p95 percentile computation over multiple runs', () => {
    // 10 runs with latencies 100, 200, 300, ..., 1000 ms
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(dispatched({ id: `sa-${i}`, model: 'haiku', agentType: 'Explore', depth: 1 }));
      lines.push(completed({ id: `sa-${i}`, status: 'succeeded', durationMs: i * 100 }));
    }
    writeRouting(lines);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });

    const bucket = result.byModelTypeDepth['haiku']?.['Explore']?.['1'];
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(10);
    // p50 = ceil(50/100 * 10) - 1 = 4 → sorted[4] = 500
    expect(bucket!.p50Ms).toBe(500);
    // p95 = ceil(95/100 * 10) - 1 = 9 → sorted[9] = 1000
    expect(bucket!.p95Ms).toBe(1000);
  });

  it('window filter: records older than days are excluded', () => {
    writeRouting([
      dispatched({ id: 'old-1', model: 'haiku', agentType: 'Explore', depth: 1, ts: oldTs() }),
      completed({ id: 'old-1', status: 'succeeded', durationMs: 999, ts: oldTs() }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.dispatchedCount).toBe(0);
    expect(result.outcomeCount).toBe(0);
  });

  it('mixed depth buckets accumulate independently', () => {
    writeRouting([
      dispatched({ id: 'sa-d1', model: 'sonnet', agentType: 'general-purpose', depth: 1 }),
      completed({ id: 'sa-d1', status: 'succeeded', durationMs: 1000 }),
      dispatched({ id: 'sa-d2', model: 'sonnet', agentType: 'general-purpose', depth: 2 }),
      completed({ id: 'sa-d2', status: 'failed', durationMs: 2000 }),
    ]);
    const result = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    expect(result.outcomeCount).toBe(2);

    const b1 = result.byModelTypeDepth['sonnet']?.['general-purpose']?.['1'];
    const b2 = result.byModelTypeDepth['sonnet']?.['general-purpose']?.['2'];
    expect(b1?.count).toBe(1);
    expect(b1?.successRate).toBe(1);
    expect(b2?.count).toBe(1);
    expect(b2?.successRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildSubagentOutcomeSummary
// ---------------------------------------------------------------------------

describe('buildSubagentOutcomeSummary', () => {
  it('returns empty array from zero aggregates', () => {
    const result = buildSubagentOutcomeSummary(zeroSubagentOutcomeAggregates());
    expect(result).toHaveLength(0);
  });

  it('filters buckets with count < minCount', () => {
    writeRouting([
      dispatched({ id: 'sa-1', model: 'haiku', agentType: 'Explore', depth: 1 }),
      completed({ id: 'sa-1', status: 'succeeded', durationMs: 1000 }),
      dispatched({ id: 'sa-2', model: 'haiku', agentType: 'Explore', depth: 1 }),
      completed({ id: 'sa-2', status: 'succeeded', durationMs: 1000 }),
      // only 2 runs — below the default minCount=3
    ]);
    const agg = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    const summary = buildSubagentOutcomeSummary(agg, 3);
    expect(summary).toHaveLength(0);
  });

  it('includes buckets that meet minCount', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 3; i++) {
      lines.push(dispatched({ id: `sa-${i}`, model: 'haiku', agentType: 'Explore', depth: 1 }));
      lines.push(completed({ id: `sa-${i}`, status: 'succeeded', durationMs: 1000 }));
    }
    writeRouting(lines);
    const agg = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    const summary = buildSubagentOutcomeSummary(agg, 3);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.model).toBe('haiku');
    expect(summary[0]!.agentType).toBe('Explore');
    expect(summary[0]!.depth).toBe(1);
    expect(summary[0]!.count).toBe(3);
    expect(summary[0]!.successRate).toBe(1);
    expect(summary[0]!.capHitRate).toBe(0);
    expect(summary[0]!.p50Ms).toBe(1000);
  });

  it('sorts by count descending (busiest bucket first)', () => {
    const lines: string[] = [];
    // Bucket A: haiku/Explore depth 1 — 5 runs
    for (let i = 1; i <= 5; i++) {
      lines.push(dispatched({ id: `a-${i}`, model: 'haiku', agentType: 'Explore', depth: 1 }));
      lines.push(completed({ id: `a-${i}`, status: 'succeeded', durationMs: 500 }));
    }
    // Bucket B: sonnet/general-purpose depth 1 — 3 runs
    for (let i = 1; i <= 3; i++) {
      lines.push(dispatched({ id: `b-${i}`, model: 'sonnet', agentType: 'general-purpose', depth: 1 }));
      lines.push(completed({ id: `b-${i}`, status: 'succeeded', durationMs: 2000 }));
    }
    writeRouting(lines);
    const agg = aggregateSubagentOutcomes({ days: 30, afkHome: tmpRoot });
    const summary = buildSubagentOutcomeSummary(agg, 3);
    expect(summary).toHaveLength(2);
    // Busiest (5 runs) should come first
    expect(summary[0]!.count).toBe(5);
    expect(summary[0]!.model).toBe('haiku');
    expect(summary[1]!.count).toBe(3);
    expect(summary[1]!.model).toBe('sonnet');
  });
});
