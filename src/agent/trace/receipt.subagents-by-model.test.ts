/**
 * Tests for `buildSubagentsByModel` and its integration with `generateReceipt`.
 *
 * Covers (per brief):
 *   - explicit `resolvedModel` on started payload wins
 *   - init-event lookup fallback under parallel dispatch ordering
 *   - `(mixed)` case when one requested name maps to multiple resolved ids
 *   - old-trace fallback to requested name when no init events present
 *   - failed and cancelled subagents counted under the right key
 *   - `byModel` absent when zero subagents started
 *   - model-less starts land in an explicit `(unknown)` bucket
 *   - invariant: sum of byModel[*].costUsd <= cost.subagentCostUsd (equal on
 *     single-cycle traces; multi-cycle REPL traces inflate subagentCostUsd
 *     because earlier root cycles lack a subagentId and are counted there)
 *   - invariant: sum of byModel[*].started equals subagents.started
 *   - nested subagents rolled up flat
 *   - regression: two terminal rows for one id — both counted (not last-write-wins)
 *   - regression: id collision across managers — started counted per event
 *   - `generateReceipt` test where the only started row has no model
 *   - multi-root-closure trace: byModel sum <= subagentCostUsd
 */

import { describe, it, expect } from 'vitest';
import { buildSubagentsByModel } from './receipt.subagents-by-model.js';
import { generateReceipt } from './receipt.js';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0 };

let seq = 0;
function ts(): string {
  return `2026-01-01T00:00:${String(seq++).padStart(2, '0')}.000Z`;
}

function started(
  subagentId: string,
  model: string,
  resolvedModel?: string,
): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'started',
      subagentId,
      parentId: 'root',
      model,
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    },
  };
}

function terminal(
  transition: 'succeeded' | 'failed' | 'cancelled',
  subagentId: string,
): TraceEvent {
  const base = {
    ts: ts(),
    seq: seq - 1,
    kind: 'subagent_lifecycle' as const,
  };
  if (transition === 'succeeded') {
    return { ...base, payload: { transition, subagentId, durationMs: 10, turnCount: 1, outputBytes: 100 } };
  }
  if (transition === 'failed') {
    return { ...base, payload: { transition, subagentId, errorClass: 'Error', errorMessage: 'boom', partialOutputBytes: 0 } };
  }
  return { ...base, payload: { transition, subagentId, source: 'cascade' as const } };
}

function initPhase(model: string, resolvedModel: string, actor: 'main' | 'subagent' = 'subagent'): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'session_phase',
    payload: { phase: 'session_init_start', model, resolvedModel, actor },
  };
}

function closureEv(subagentId: string, finalCostUsd: number): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'closure',
    payload: { reason: 'model_end_turn', finalCostUsd, subagentId, finalTurnCount: 1, finalTokens: ZERO_TOKENS },
  };
}

function sealed(): TraceEvent {
  return {
    ts: ts(),
    seq: seq - 1,
    kind: 'session_sealed',
    payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: ts() },
  };
}

const META = { tracePath: '/x/witness/run-t/trace.jsonl', witnessLabel: 'run-t' };

// ---------------------------------------------------------------------------
// buildSubagentsByModel unit tests
// ---------------------------------------------------------------------------

describe('buildSubagentsByModel', () => {
  beforeEach(() => { seq = 0; });

  it('returns undefined when no subagents started', () => {
    expect(buildSubagentsByModel([])).toBeUndefined();
    expect(buildSubagentsByModel([sealed()])).toBeUndefined();
  });

  it('uses explicit resolvedModel on started payload (priority 1)', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet', 'claude-sonnet-4-6-explicit'),
      terminal('succeeded', 'sa1'),
      closureEv('sa1', 0.05),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(Object.keys(rollup!)).toEqual(['claude-sonnet-4-6-explicit']);
    expect(rollup!['claude-sonnet-4-6-explicit']).toMatchObject({
      started: 1, succeeded: 1, failed: 0, cancelled: 0,
      requested: ['sonnet'],
    });
  });

  it('falls back to init-event lookup (priority 2) when no resolvedModel on started', () => {
    // init event arrives AFTER the started event (parallel dispatch ordering).
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      terminal('succeeded', 'sa2'),
      closureEv('sa1', 0.03),
      closureEv('sa2', 0.02),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(Object.keys(rollup!)).toEqual(['claude-sonnet-4-6']);
    expect(rollup!['claude-sonnet-4-6']).toMatchObject({
      started: 2, succeeded: 2, costUsd: expect.closeTo(0.05, 10),
      requested: ['sonnet'],
    });
  });

  it('produces (mixed) key when one requested name resolves to multiple ids', () => {
    const events: TraceEvent[] = [
      started('sa1', 'medium'),
      started('sa2', 'medium'),
      initPhase('medium', 'claude-sonnet-4-6'),
      initPhase('medium', 'claude-opus-4-5'),
      terminal('succeeded', 'sa1'),
      terminal('succeeded', 'sa2'),
      closureEv('sa1', 0.04),
      closureEv('sa2', 0.06),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    const keys = Object.keys(rollup!);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('medium (mixed)');
    expect(rollup!['medium (mixed)']).toMatchObject({
      started: 2, succeeded: 2,
      costUsd: expect.closeTo(0.10, 10),
      requested: ['medium'],
    });
  });

  it('falls back to requested name on old traces with no init events (priority 4)', () => {
    const events: TraceEvent[] = [
      started('sa1', 'haiku'),
      terminal('succeeded', 'sa1'),
      closureEv('sa1', 0.01),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    expect(Object.keys(rollup!)).toEqual(['haiku']);
    expect(rollup!['haiku']?.requested).toEqual(['haiku']);
  });

  it('counts failed and cancelled subagents under the right key', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'sonnet'),
      started('sa3', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('failed', 'sa1'),
      terminal('cancelled', 'sa2'),
      terminal('succeeded', 'sa3'),
      closureEv('sa3', 0.02),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup!['claude-sonnet-4-6']).toMatchObject({
      started: 3, succeeded: 1, failed: 1, cancelled: 1,
    });
  });

  it('rolls up multiple requested names into separate keys', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'haiku'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      initPhase('haiku', 'claude-haiku-5-5'),
      terminal('succeeded', 'sa1'),
      terminal('succeeded', 'sa2'),
      closureEv('sa1', 0.05),
      closureEv('sa2', 0.01),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(Object.keys(rollup!).sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-4-6']);
    expect(rollup!['claude-sonnet-4-6']?.started).toBe(1);
    expect(rollup!['claude-haiku-5-5']?.started).toBe(1);
  });

  it('rolls up nested subagents (depth > 1) flat', () => {
    // Child dispatches its own child: both appear in the root trace.
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),           // depth-1
      started('sa1-child', 'haiku'),      // depth-2 dispatched by sa1
      initPhase('sonnet', 'claude-sonnet-4-6'),
      initPhase('haiku', 'claude-haiku-5-5'),
      terminal('succeeded', 'sa1-child'),
      terminal('succeeded', 'sa1'),
      closureEv('sa1-child', 0.01),
      closureEv('sa1', 0.05),
    ];
    const rollup = buildSubagentsByModel(events);
    const keys = Object.keys(rollup!).sort();
    expect(keys).toEqual(['claude-haiku-5-5', 'claude-sonnet-4-6']);
    expect(rollup!['claude-haiku-5-5']?.started).toBe(1);
    expect(rollup!['claude-sonnet-4-6']?.started).toBe(1);
  });

  it('ignores main actor init events for the resolution map', () => {
    // The root session's init event must not pollute the subagent lookup.
    const events: TraceEvent[] = [
      initPhase('fable', 'claude-fable-5-2', 'main'),
      started('sa1', 'fable'),
      // No subagent init event for 'fable': falls back to requested name.
      terminal('succeeded', 'sa1'),
      closureEv('sa1', 0.03),
    ];
    const rollup = buildSubagentsByModel(events);
    // 'main' init event must not map fable -> claude-fable-5-2 for subagent lookup.
    expect(Object.keys(rollup!)).toEqual(['fable']);
  });

  it('tolerates malformed subagent_lifecycle and closure events gracefully', () => {
    const events: TraceEvent[] = [
      // started with no model: lands in (unknown)
      { ts: ts(), seq: seq - 1, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sa-bad' } } as unknown as TraceEvent,
      // closure with no subagentId: should not throw
      { ts: ts(), seq: seq - 1, kind: 'closure', payload: { reason: 'model_end_turn', finalCostUsd: 0.01 } } as unknown as TraceEvent,
      started('sa1', 'sonnet'),
      terminal('succeeded', 'sa1'),
    ];
    expect(() => buildSubagentsByModel(events)).not.toThrow();
    const rollup = buildSubagentsByModel(events);
    expect(rollup!['sonnet']?.started).toBe(1);
    // sa-bad had no model: counted in the (unknown) bucket.
    expect(rollup!['(unknown)']?.started).toBe(1);
  });

  it('puts model-less started rows in an (unknown) bucket', () => {
    const events: TraceEvent[] = [
      // started with no model field
      { ts: ts(), seq: seq - 1, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sa-nomodel' } } as unknown as TraceEvent,
      terminal('failed', 'sa-nomodel'),
    ];
    const rollup = buildSubagentsByModel(events);
    // Must return a non-undefined rollup (not silently dropped or ??\ {}).
    expect(rollup).toBeDefined();
    expect(rollup!['(unknown)']).toMatchObject({ started: 1, failed: 1 });
  });

  // Regression: two terminal rows for one id.
  // A cancel that races a completed run emits both `succeeded` and `cancelled`
  // for the same id. The last-write-wins `transitions.set` previously collapsed
  // these into a single terminal, so the bucket showed only one terminal while
  // generateReceipt counted two.
  it('regression: counts both terminal rows when one id has two terminal events', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      terminal('cancelled', 'sa1'), // race: cancel arrives after success
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // Both terminal events must be counted.
    expect(rollup!['claude-sonnet-4-6']).toMatchObject({
      started: 1,
      succeeded: 1,
      cancelled: 1,
      failed: 0,
    });
  });

  // Regression: id collision across managers.
  // Two managers minting the same id produce two `started` rows with the same
  // subagentId. The previous `requested.set(id, req)` collapsed them into one
  // map entry, so Pass 3 only counted one `started` while generateReceipt
  // counted two.
  it('regression: counts started per event when two rows share the same subagentId', () => {
    const events: TraceEvent[] = [
      started('collide-1', 'sonnet'),  // manager A
      started('collide-1', 'sonnet'),  // manager B — same id, same model
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'collide-1'),
      terminal('succeeded', 'collide-1'),
    ];
    const rollup = buildSubagentsByModel(events);
    expect(rollup).toBeDefined();
    // Both started rows and both terminal rows must be counted.
    expect(rollup!['claude-sonnet-4-6']).toMatchObject({
      started: 2,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration with generateReceipt
// ---------------------------------------------------------------------------

import { beforeEach } from 'vitest';

describe('generateReceipt: subagents.byModel', () => {
  beforeEach(() => { seq = 0; });

  it('omits byModel when no subagents started', () => {
    const r = generateReceipt([sealed()], META);
    expect('byModel' in r.subagents).toBe(false);
  });

  it('byModel is present when subagents started', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      closureEv('sa1', 0.03),
      sealed(),
    ];
    const r = generateReceipt(events, META);
    expect(r.subagents.byModel).toBeDefined();
    expect(r.subagents.byModel!['claude-sonnet-4-6']).toMatchObject({ started: 1, succeeded: 1 });
  });

  it('invariant: sum of byModel[*].started equals subagents.started', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'haiku'),
      started('sa3', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      initPhase('haiku', 'claude-haiku-5-5'),
      terminal('succeeded', 'sa1'),
      terminal('failed', 'sa2'),
      terminal('cancelled', 'sa3'),
      closureEv('sa1', 0.05),
      sealed(),
    ];
    const r = generateReceipt(events, META);
    const byModel = r.subagents.byModel!;
    const sumStarted = Object.values(byModel).reduce((n, b) => n + b.started, 0);
    expect(sumStarted).toBe(r.subagents.started);
    expect(r.subagents.started).toBe(3);
  });

  // Regression integration: two terminal rows for one id — byModel must agree
  // with top-level subagents counters (both see succeeded:1, cancelled:1).
  it('regression: byModel terminal counts match top-level when one id has two terminal rows', () => {
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      terminal('cancelled', 'sa1'),
      sealed(),
    ];
    const r = generateReceipt(events, META);
    // Top-level sees both rows.
    expect(r.subagents.succeeded).toBe(1);
    expect(r.subagents.cancelled).toBe(1);
    // byModel bucket must agree.
    const bucket = r.subagents.byModel!['claude-sonnet-4-6'];
    expect(bucket).toBeDefined();
    expect(bucket!.succeeded).toBe(r.subagents.succeeded);
    expect(bucket!.cancelled).toBe(r.subagents.cancelled);
  });

  // Regression integration: id collision — byModel.started must equal top-level.
  it('regression: byModel.started matches top-level when two rows share the same subagentId', () => {
    const events: TraceEvent[] = [
      started('collide-1', 'sonnet'),
      started('collide-1', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'collide-1'),
      terminal('succeeded', 'collide-1'),
      sealed(),
    ];
    const r = generateReceipt(events, META);
    expect(r.subagents.started).toBe(2);
    expect(r.subagents.succeeded).toBe(2);
    const bucket = r.subagents.byModel!['claude-sonnet-4-6'];
    expect(bucket).toBeDefined();
    expect(bucket!.started).toBe(r.subagents.started);
    expect(bucket!.succeeded).toBe(r.subagents.succeeded);
  });

  it('invariant: sum of byModel[*].costUsd equals cost.subagentCostUsd on a single-cycle trace', () => {
    // Single-cycle: exactly one root closure. byModel sums only subagent
    // closures (which carry a subagentId); subagentCostUsd = total - root.
    // On a single-cycle trace the two figures are the same.
    const events: TraceEvent[] = [
      started('sa1', 'sonnet'),
      started('sa2', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      terminal('succeeded', 'sa2'),
      closureEv('sa1', 0.04),
      closureEv('sa2', 0.02),
      // Root closure (no subagentId) and seal.
      {
        ts: ts(), seq: seq - 1, kind: 'closure',
        payload: { reason: 'model_end_turn', finalCostUsd: 0.01, finalTurnCount: 1, finalTokens: ZERO_TOKENS },
      } as unknown as TraceEvent,
      {
        ts: ts(), seq: seq - 1, kind: 'session_sealed',
        payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: ts() },
      } as unknown as TraceEvent,
    ];
    const r = generateReceipt(events, META);
    const byModel = r.subagents.byModel!;
    const sumCost = Object.values(byModel).reduce((n, b) => n + b.costUsd, 0);
    // Both subagents landed in claude-sonnet-4-6.
    expect(sumCost).toBeCloseTo(0.06, 10);
    // subagentCostUsd from SessionCostAccumulator should also be 0.06.
    expect(r.cost.subagentCostUsd).toBeCloseTo(0.06, 10);
    expect(sumCost).toBeCloseTo(r.cost.subagentCostUsd!, 10);
  });

  it('generateReceipt: only started row has no model — byModel has (unknown) bucket', () => {
    // Finding 2: when every started row is model-less, byModel must not be
    // absent (which the old `?? {}` path produced as an empty object) —
    // it must carry an (unknown) bucket so the started invariant holds.
    const events: TraceEvent[] = [
      { ts: ts(), seq: seq - 1, kind: 'subagent_lifecycle',
        payload: { transition: 'started', subagentId: 'sa-nomodel' } } as unknown as TraceEvent,
      terminal('failed', 'sa-nomodel'),
      sealed(),
    ];
    const r = generateReceipt(events, META);
    expect(r.subagents.started).toBe(1);
    expect(r.subagents.byModel).toBeDefined();
    expect(r.subagents.byModel!['(unknown)']).toMatchObject({ started: 1, failed: 1 });
    // started invariant holds.
    const sumStarted = Object.values(r.subagents.byModel!).reduce((n, b) => n + b.started, 0);
    expect(sumStarted).toBe(r.subagents.started);
  });

  it('multi-root-closure trace: byModel sum <= cost.subagentCostUsd', () => {
    // Finding 3: on a multi-cycle REPL trace, earlier root cycles emit a
    // closure with no subagentId. SessionCostAccumulator attributes them to
    // subagentCostUsd (total - last root cost), so subagentCostUsd > byModel
    // sum (which only counts closures that carry a subagentId).
    const events: TraceEvent[] = [
      // Cycle 1 root closure (no subagentId) — simulates a /clear cycle.
      {
        ts: ts(), seq: seq - 1, kind: 'closure',
        payload: { reason: 'model_end_turn', finalCostUsd: 0.05, finalTurnCount: 2, finalTokens: ZERO_TOKENS },
      } as unknown as TraceEvent,
      // Subagent started in cycle 2.
      started('sa1', 'sonnet'),
      initPhase('sonnet', 'claude-sonnet-4-6'),
      terminal('succeeded', 'sa1'),
      closureEv('sa1', 0.03),
      // Cycle 2 root closure.
      {
        ts: ts(), seq: seq - 1, kind: 'closure',
        payload: { reason: 'model_end_turn', finalCostUsd: 0.02, finalTurnCount: 1, finalTokens: ZERO_TOKENS },
      } as unknown as TraceEvent,
      {
        ts: ts(), seq: seq - 1, kind: 'session_sealed',
        payload: { status: 'succeeded', finalCostUsd: 0.02, finalTurnCount: 1, closedAt: ts() },
      } as unknown as TraceEvent,
    ];
    const r = generateReceipt(events, META);
    const byModel = r.subagents.byModel!;
    const sumCost = Object.values(byModel).reduce((n, b) => n + b.costUsd, 0);
    // byModel only sees the subagent closure (0.03).
    expect(sumCost).toBeCloseTo(0.03, 10);
    // subagentCostUsd = total(0.10) - root(0.02) = 0.08 — includes cycle 1.
    expect(r.cost.subagentCostUsd).toBeDefined();
    expect(sumCost).toBeLessThanOrEqual(r.cost.subagentCostUsd!);
    // The equality does NOT hold on this multi-cycle trace.
    expect(sumCost).not.toBeCloseTo(r.cost.subagentCostUsd!, 10);
  });
});

// ---------------------------------------------------------------------------
// renderReceiptMarkdown: byModel rows
// ---------------------------------------------------------------------------

import { renderReceiptMarkdown } from './receipt.js';
import type { RunReceipt } from './receipt.js';
import { RECEIPT_SCHEMA_VERSION } from './receipt.js';

const BASE: RunReceipt = {
  schemaVersion: RECEIPT_SCHEMA_VERSION,
  generatedAt: '2026-01-01T00:00:00.000Z',
  witnessLabel: 'run-t',
  tracePath: '/x/trace.jsonl',
  status: 'succeeded',
  incomplete: false,
  humanReviewRequired: false,
  humanReviewReasons: [],
  toolCalls: { total: 0, succeeded: 0, errored: 0, erroredNotable: 0, refused: 0, circuitBreakerHits: 0, byTool: {}, byFailureClass: {} },
  events: { total: 0, byKind: {} },
  subagents: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
  cost: {},
  failures: [],
  limitations: [],
};

describe('renderReceiptMarkdown: byModel rows', () => {
  it('renders per-model rows when byModel is present', () => {
    const r: RunReceipt = {
      ...BASE,
      subagents: {
        started: 2,
        succeeded: 2,
        failed: 0,
        cancelled: 0,
        byModel: {
          'claude-sonnet-4-6': { started: 2, succeeded: 2, failed: 0, cancelled: 0, costUsd: 0.05, requested: ['sonnet'] },
        },
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Subagents |');
    expect(md).toContain('| Subagents (claude-sonnet-4-6) |');
    expect(md).toContain('$0.0500');
  });

  it('omits per-model rows when byModel is absent', () => {
    const r: RunReceipt = {
      ...BASE,
      subagents: { started: 1, succeeded: 1, failed: 0, cancelled: 0 },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Subagents |');
    expect(md).not.toContain('| Subagents (');
  });

  it('omits subagent rows entirely when no subagents started', () => {
    const md = renderReceiptMarkdown(BASE);
    expect(md).not.toContain('| Subagents |');
  });
});
