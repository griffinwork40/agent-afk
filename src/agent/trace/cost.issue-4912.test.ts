/**
 * #4912: multi-cycle root/subagent split after a crash, a late child
 * closure, and an unsealed ambiguous trace.
 */
import { describe, expect, it } from 'vitest';
import { computeSessionCost, type CostEventLike } from './cost.js';
import { traceToOtlp } from './otlp-export.js';
import type { TraceEvent } from './types.js';

const ts = '2026-11-14T00:00:00.000Z';
let seq = 0;

function root(cost: number, turns: number): TraceEvent {
  return { ts, seq: seq++, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: turns, finalCostUsd: cost, finalTokens: {} } } as unknown as TraceEvent;
}
function child(cost: number, id = 'child-1', turns = 1): TraceEvent {
  return { ts, seq: seq++, kind: 'closure', payload: { reason: 'cancelled', finalTurnCount: turns, finalCostUsd: cost, finalTokens: {}, subagentId: id } } as unknown as TraceEvent;
}
function sealed(cost: number, turns: number): TraceEvent {
  return { ts, seq: seq++, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: cost, finalTurnCount: turns, closedAt: ts } } as unknown as TraceEvent;
}
function started(id: string): TraceEvent {
  return { ts, seq: seq++, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: id, parentId: 'root' } } as unknown as TraceEvent;
}
const backstop: CostEventLike = {
  kind: 'session_sealed',
  payload: { status: 'failed', finalCostUsd: 0, finalTurnCount: 0, closedAt: ts, incomplete: true },
};

describe('#4912 item 1: crash after /clear keeps closed root cycles as root spend', () => {
  it('no subagent activity: the closed cycle is root spend, not subagent spend', () => {
    const r = computeSessionCost([root(1, 4), backstop]);
    expect(r.source).toBe('closures-incomplete');
    expect(r.totalCostUsd).toBe(1);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBe(0);
    expect(r.rootTurnCount).toBe(4);
  });

  it('stamped child closure: unstamped closures are root, stamped ones subagent', () => {
    const r = computeSessionCost([started('child-1'), child(0.5), root(1, 4), backstop]);
    expect(r.totalCostUsd).toBeCloseTo(1.5);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBeCloseTo(0.5);
    expect(r.rootTurnCount).toBe(4);
  });

  it('only stamped child closures survive: root stays unknown', () => {
    const r = computeSessionCost([started('child-1'), child(0.5), backstop]);
    expect(r.rootCostUsd).toBeUndefined();
    expect(r.rootTurnCount).toBeUndefined();
    expect(r.subagentCostUsd).toBe(0.5);
  });

  it('ambiguous provenance (case 3): root stays unknown, every closure is subagent spend', () => {
    const r = computeSessionCost([started('a'), root(1, 4), root(0.5, 1), backstop]);
    expect(r.rootCostUsd).toBeUndefined();
    expect(r.subagentCostUsd).toBeCloseTo(1.5);
  });
});

describe('#4912 item 2: a child closure after the root\'s final closure is not a lost root closure', () => {
  it('issue example: root $1.00, root $0.25, late child $0.50, seal $0.25', () => {
    const r = computeSessionCost([started('child-1'), root(1, 4), root(0.25, 1), child(0.5), sealed(0.25, 1)]);
    expect(r.rootCostUsd).toBeCloseTo(1.25);
    expect(r.totalCostUsd).toBeCloseTo(1.75);
    expect(r.subagentCostUsd).toBeCloseTo(0.5);
    expect(r.rootTurnCount).toBe(5);
  });

  it('two cycles with equal cost but a lost final closure: turn count tells them apart', () => {
    // Cycle 1 closed ($0.25, 3 turns); cycle 2 ($0.25, 1 turn) lost its
    // closure, then a late child closed. The seal is cycle 2.
    const r = computeSessionCost([started('child-1'), root(0.25, 3), child(0.5), sealed(0.25, 1)]);
    expect(r.rootCostUsd).toBeCloseTo(0.5);
    expect(r.totalCostUsd).toBeCloseTo(1);
    expect(r.rootTurnCount).toBe(4);
  });

  it('a lost final root closure followed by a child closure still adds the seal', () => {
    const r = computeSessionCost([started('child-1'), root(1, 4), child(0.5), sealed(0.25, 1)]);
    expect(r.rootCostUsd).toBeCloseTo(1.25);
    expect(r.totalCostUsd).toBeCloseTo(1.75);
    expect(r.rootTurnCount).toBe(5);
  });
});

describe('#4912 item 4: an unsealed ambiguous trace reports turns with its cost', () => {
  it('case 3 without a seal falls back to the last closure for cost and turns', () => {
    const r = computeSessionCost([started('a'), root(2, 7), root(1, 3)]);
    expect(r.rootCostUsd).toBe(1);
    expect(r.rootTurnCount).toBe(3);
  });

  it('the OTLP session span carries both cost and turn count', () => {
    const events = [started('a'), root(2, 7), root(1, 3)];
    const span = traceToOtlp(events, { sessionId: 'abc123def456abc1' }).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toContain('gen_ai.usage.cost_usd');
    expect(keys).toContain('afk.session.turn_count');
  });
});
