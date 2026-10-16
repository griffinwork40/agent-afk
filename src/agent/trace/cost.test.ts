/**
 * Tests for the shared session-cost definition (#3879).
 */
import { describe, expect, it } from 'vitest';
import { computeSessionCost, type CostEventLike } from './cost.js';
import { generateReceipt } from './receipt.js';
import { parseTraceSignals } from '../facets/derive.trace.js';
import type { TraceEvent } from './types.js';

const ts = '2026-10-16T00:00:00.000Z';
let seq = 0;

function closure(cost: number, tokens: Record<string, number> = {}): TraceEvent {
  return {
    ts,
    seq: seq++,
    kind: 'closure',
    payload: { reason: 'model_end_turn', finalTurnCount: 1, finalCostUsd: cost, finalTokens: tokens },
  } as unknown as TraceEvent;
}

function sealed(root: number, subagent?: number): TraceEvent {
  return {
    ts,
    seq: seq++,
    kind: 'session_sealed',
    payload: {
      status: 'succeeded',
      finalCostUsd: root,
      finalTurnCount: 1,
      closedAt: ts,
      ...(subagent !== undefined ? { subagentCostUsd: subagent } : {}),
    },
  } as unknown as TraceEvent;
}

function started(id: string, parentId: string): TraceEvent {
  return {
    ts,
    seq: seq++,
    kind: 'subagent_lifecycle',
    payload: { transition: 'started', subagentId: id, parentId },
  } as unknown as TraceEvent;
}

const toJsonl = (events: TraceEvent[]): string => events.map((e) => JSON.stringify(e)).join('\n');

/**
 * Fan-out fixture: root ($1) with two succeeded children ($2, $3), one failed
 * child ($0.5) and one grandchild ($0.25). The seal's success-path rollup
 * only saw the two succeeded children, so it reports subagent = $5.
 */
function fanOutTrace(): TraceEvent[] {
  return [
    started('a', 'root'),
    started('b', 'root'),
    started('c', 'root'),
    started('a1', 'a'),
    closure(0.25, { input: 10 }),
    closure(2, { input: 20 }),
    closure(3, { input: 30 }),
    closure(0.5, { input: 5 }),
    closure(1, { input: 100, output: 7 }),
    sealed(1, 5),
  ];
}

describe('computeSessionCost', () => {
  it('returns source none and no figures for an empty trace', () => {
    expect(computeSessionCost([])).toEqual({ closureCount: 0, source: 'none' });
  });

  it('root-only trace: total equals root, subagent is 0', () => {
    const r = computeSessionCost([closure(1.5), sealed(1.5)]);
    expect(r).toMatchObject({ rootCostUsd: 1.5, subagentCostUsd: 0, totalCostUsd: 1.5, source: 'closures+seal' });
  });

  it('fan-out trace: total sums every closure, including failed and nested children', () => {
    const r = computeSessionCost(fanOutTrace());
    expect(r.totalCostUsd).toBeCloseTo(6.75);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBeCloseTo(5.75);
    expect(r.closureCount).toBe(5);
    expect(r.totalTokens).toEqual({ input: 165, output: 7 });
  });

  it('never reports less than seal root + seal subagent (lost root closure)', () => {
    // Root crashed after the seal rollup but before writing its closure.
    const r = computeSessionCost([closure(2), sealed(1, 2)]);
    expect(r.totalCostUsd).toBe(3);
    expect(r.subagentCostUsd).toBe(2);
  });

  it('trace with no seal: root falls back to the last closure', () => {
    const r = computeSessionCost([closure(2), closure(1)]);
    expect(r).toMatchObject({ rootCostUsd: 1, subagentCostUsd: 2, totalCostUsd: 3, source: 'closures' });
  });

  it('seal without closures: falls back to seal root + seal subagent', () => {
    const r = computeSessionCost([sealed(1, 4)]);
    expect(r).toMatchObject({ rootCostUsd: 1, subagentCostUsd: 4, totalCostUsd: 5, source: 'seal' });
  });

  it('multi-cycle REPL root: disjoint per-cycle closures are summed', () => {
    // `/clear` re-zeroes the root accumulator, so each cycle closes with its
    // own spend and the seal covers only the last cycle.
    const r = computeSessionCost([closure(1.127), closure(0.812), sealed(0.812)]);
    expect(r.totalCostUsd).toBeCloseTo(1.939);
    expect(r.rootCostUsd).toBe(0.812);
  });

  it('ignores malformed payloads and non-finite costs', () => {
    const junk: CostEventLike[] = [
      { kind: 'closure' },
      { kind: 'closure', payload: { finalCostUsd: Number.NaN } },
      { kind: 'closure', payload: { finalCostUsd: -3 } },
      { kind: 'closure', payload: { finalCostUsd: 2 } },
    ];
    const r = computeSessionCost(junk);
    expect(r.totalCostUsd).toBe(2);
    expect(r.closureCount).toBe(3);
  });
});

describe('consumers agree with computeSessionCost (#3879 acceptance)', () => {
  it('receipt totalCostUsd equals the helper total; finalCostUsd stays root-only', () => {
    const events = fanOutTrace();
    const receipt = generateReceipt(events, { tracePath: '/x/w/trace.jsonl', witnessLabel: 'w' });
    const expected = computeSessionCost(events);
    expect(receipt.cost.totalCostUsd).toBe(expected.totalCostUsd);
    expect(receipt.cost.subagentCostUsd).toBe(expected.subagentCostUsd);
    expect(receipt.cost.rootCostUsd).toBe(1);
    expect(receipt.cost.finalCostUsd).toBe(1);
    expect(receipt.cost.costSource).toBe('closures+seal');
  });

  it('facet trace signals carry the same total', () => {
    const events = fanOutTrace();
    const signals = parseTraceSignals(toJsonl(events));
    const expected = computeSessionCost(events);
    expect(signals.totalCostUsd).toBe(expected.totalCostUsd);
    expect(signals.subagentCostUsd).toBe(expected.subagentCostUsd);
  });

  it('facet trace signals omit cost fields for a trace with no cost records', () => {
    const signals = parseTraceSignals(toJsonl([started('a', 'root')]));
    expect(signals).not.toHaveProperty('totalCostUsd');
    expect(signals).not.toHaveProperty('subagentCostUsd');
  });
});
