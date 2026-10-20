/**
 * Tests for the shared session-cost definition (#3879).
 */
import { describe, expect, it } from 'vitest';
import { computeSessionCost, SessionCostAccumulator, type CostEventLike } from './cost.js';
import { generateReceipt } from './receipt.js';
import { parseTraceSignals } from '../facets/derive.trace.js';
import type { TraceEvent } from './types.js';
import { InMemoryTraceWriter } from './writer.js';
import { emitClosureEvent, type ClosureSignals, type ClosureTokenCounters } from '../session/closure-emitter.js';

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

/** A closure event stamped with a child subagentId (provenance-aware, #3932). */
function closureChild(cost: number, subagentId = 'child-1'): TraceEvent {
  return {
    ts,
    seq: seq++,
    kind: 'closure',
    payload: { reason: 'cancelled', finalTurnCount: 1, finalCostUsd: cost, finalTokens: {}, subagentId },
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
    // root closure write failed; seal succeeded.
    const r = computeSessionCost([closure(2), sealed(1, 2)]);
    // closureSum($2) + sealRoot($1) = $3; Math.max($3, sealTotal($3)) = $3
    expect(r.totalCostUsd).toBe(3);
    expect(r.subagentCostUsd).toBe(2);
  });

  it('lost-root with seal lower bound higher than closureSum+sealRoot: uses sealTotal (#3890 item 2 fix)', () => {
    // closure($2) child only; sealed(root=$1, sub=$5) => sealTotal=$6
    // closureSum($2) + sealRoot($1) = $3 < sealTotal($6); must report $6
    const r = computeSessionCost([closure(2), sealed(1, 5)]);
    expect(r.totalCostUsd).toBe(6);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBe(5);
  });

  it('lost-root-closure: $2 failed-child closure + sealed(1) reports $3 not $2 (#3890 item 1)', () => {
    // closureSum=$2 (failed child only), sealRoot=$1, sealSubagent=$0
    // Math.max(2,1)=$2 is wrong; correct total is closureSum + sealRoot = $3
    const r = computeSessionCost([closure(2), sealed(1)]);
    expect(r.totalCostUsd).toBe(3);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBe(2);
  });

  it('backstop seal (incomplete:true): root absent, subagent = closureSum, source closures-incomplete (#3890 item 2)', () => {
    // sealOnProcessExit writes finalCostUsd:0 + incomplete:true; root closure is
    // missing — all surviving closures are children, root is unknown.
    const backstopSeal: CostEventLike = {
      kind: 'session_sealed',
      payload: { status: 'failed', finalCostUsd: 0, subagentCostUsd: 0, incomplete: true, finalTurnCount: 0, closedAt: ts },
    };
    const r = computeSessionCost([closure(1.5), closure(0.75), backstopSeal]);
    expect(r.totalCostUsd).toBeCloseTo(2.25);
    expect(r.rootCostUsd).toBeUndefined();
    expect(r.subagentCostUsd).toBeCloseTo(2.25);
    expect(r.source).toBe('closures-incomplete');
  });

  it('backstop seal with zero closures: total 0, root absent, source closures-incomplete', () => {
    // Honest: zero valid closures survived — we know nothing about root or subagents.
    const backstopSeal: CostEventLike = {
      kind: 'session_sealed',
      payload: { status: 'failed', finalCostUsd: 0, subagentCostUsd: 0, incomplete: true, finalTurnCount: 0, closedAt: ts },
    };
    const r = computeSessionCost([backstopSeal]);
    expect(r.totalCostUsd).toBe(0);
    expect(r.rootCostUsd).toBeUndefined();
    expect(r.subagentCostUsd).toBe(0);
    expect(r.source).toBe('closures-incomplete');
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

  // --- #3932 acceptance criteria ---

  it('#3932 AC1: $1 failed-child closure (with subagentId) + sealed(1) totals $2 not $1', () => {
    // Old heuristic: lastClosureCost($1) === sealRoot($1) → rootClosureLost=false → total=$1 (wrong).
    // New heuristic: lastClosureSubagentId is set → rootClosureLost=true → total=$1+$1=$2.
    const r = computeSessionCost([closureChild(1), sealed(1)]);
    expect(r.totalCostUsd).toBe(2);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBe(1);
  });

  it('#3932 AC2: old trace without subagentId on closure behaves as today (equality fallback)', () => {
    // closure() has no subagentId → falls back to equality: lastClosureCost($1) === sealRoot($1)
    // → rootClosureLost=false → total=$1 (normal root-only trace, unchanged behaviour).
    const r = computeSessionCost([closure(1), sealed(1)]);
    expect(r.totalCostUsd).toBe(1);
    expect(r.rootCostUsd).toBe(1);
    expect(r.subagentCostUsd).toBe(0);
  });

  it('ignores malformed payloads and non-finite costs; closureCount = valid closures only (#3890 item 3)', () => {
    const junk: CostEventLike[] = [
      { kind: 'closure' },                                       // no payload — skipped
      { kind: 'closure', payload: { finalCostUsd: Number.NaN } }, // NaN — skipped
      { kind: 'closure', payload: { finalCostUsd: -3 } },        // negative — skipped
      { kind: 'closure', payload: { finalCostUsd: 2 } },         // valid
    ];
    const r = computeSessionCost(junk);
    expect(r.totalCostUsd).toBe(2);
    expect(r.closureCount).toBe(1); // only the valid closure counts
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

// ---------------------------------------------------------------------------
// #4007 — closure provenance through the real emitClosureEvent path
//
// The #3932 AC1/AC2 tests inject `subagentId` via the synthetic closureChild()
// helper, proving the accumulator logic but NOT that emitClosureEvent actually
// stamps the field. This suite exercises the real emission path so that a
// future deletion of the `subagentId` stamping in closure-emitter.ts would
// cause a deterministic test failure rather than a silent cost-equality
// regression.
// ---------------------------------------------------------------------------

describe('#4007 closure provenance through emitClosureEvent', () => {
  const cleanSignal = new AbortController().signal;
  const zeroTokens: ClosureTokenCounters = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const baseSignals: ClosureSignals = {
    dispatchReason: 'close',
    signal: cleanSignal,
    maxTurnsHit: false,
    hookBlocked: false,
    lastStopReason: undefined,
    sawProviderError: false,
  };

  it('accumulator takes the provenance branch when closure is emitted via emitClosureEvent with subagentId', async () => {
    // This is the key regression guard: a child closure emitted through the
    // real path must make the accumulator treat the root closure as lost
    // (rootClosureLost=true via subagentId presence) and add sealRoot to the
    // child closure sum — yielding $2, not $1 as the old equality heuristic did.
    const childWriter = new InMemoryTraceWriter();
    await emitClosureEvent(childWriter, {
      ...baseSignals,
      dispatchReason: 'close',
      subagentId: 'child-xyz',
      finalTurnCount: 2,
      finalCostUsd: 1.0,
      runningTokens: zeroTokens,
    });

    const childClosureEvent = childWriter.events[0];
    expect(childClosureEvent?.kind).toBe('closure');

    // Construct a realistic trace: child closure then a root seal (sealRoot=$1).
    const sealEvent: CostEventLike = {
      kind: 'session_sealed',
      payload: { finalCostUsd: 1.0, subagentCostUsd: 0, finalTurnCount: 3, closedAt: ts, status: 'succeeded' },
    };

    const acc = new SessionCostAccumulator();
    acc.add(childClosureEvent!);
    acc.add(sealEvent);
    const result = acc.result();

    // rootClosureLost=true because lastClosureSubagentId='child-xyz' (not null).
    // total = closureSum($1) + sealRoot($1) = $2.
    expect(result.totalCostUsd).toBe(2);
    expect(result.rootCostUsd).toBe(1);
    expect(result.subagentCostUsd).toBe(1);
    expect(result.source).toBe('closures+seal');
  });

  it('accumulator falls back to equality heuristic when subagentId is absent (root closure)', async () => {
    // Mirrors #3932 AC2 but through the real emission path: a root closure
    // (no subagentId) whose cost equals sealRoot → rootClosureLost=false → $1.
    const rootWriter = new InMemoryTraceWriter();
    await emitClosureEvent(rootWriter, {
      ...baseSignals,
      finalTurnCount: 1,
      finalCostUsd: 1.0,
      runningTokens: zeroTokens,
    });

    const rootClosureEvent = rootWriter.events[0];
    expect(rootClosureEvent?.kind).toBe('closure');

    const sealEvent: CostEventLike = {
      kind: 'session_sealed',
      payload: { finalCostUsd: 1.0, subagentCostUsd: 0, finalTurnCount: 1, closedAt: ts, status: 'succeeded' },
    };

    const acc = new SessionCostAccumulator();
    acc.add(rootClosureEvent!);
    acc.add(sealEvent);
    const result = acc.result();

    // lastClosureSubagentId=null (root) → equality fallback: $1===$1 → rootClosureLost=false.
    expect(result.totalCostUsd).toBe(1);
    expect(result.rootCostUsd).toBe(1);
    expect(result.subagentCostUsd).toBe(0);
    expect(result.source).toBe('closures+seal');
  });

  it('two-child-closure case: both children emitted via emitClosureEvent accumulate correctly', async () => {
    // Regression guard: a trace with TWO child closures (each stamped with a
    // distinct subagentId by the real emission path) must sum both costs and
    // add sealRoot — exercising the multi-closure accumulator path end-to-end.
    const writerA = new InMemoryTraceWriter();
    await emitClosureEvent(writerA, {
      ...baseSignals,
      subagentId: 'child-a',
      finalTurnCount: 1,
      finalCostUsd: 1.0,
      runningTokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    });

    const writerB = new InMemoryTraceWriter();
    await emitClosureEvent(writerB, {
      ...baseSignals,
      subagentId: 'child-b',
      finalTurnCount: 2,
      finalCostUsd: 2.0,
      runningTokens: { input: 20, output: 10, cacheRead: 0, cacheCreation: 0 },
    });

    const childA = writerA.events[0];
    const childB = writerB.events[0];
    expect(childA?.kind).toBe('closure');
    expect(childB?.kind).toBe('closure');

    // Root seal reports its own cost ($0.5); no subagentCostUsd in seal
    // (old-style seal without rollup).
    const sealEvent: CostEventLike = {
      kind: 'session_sealed',
      payload: { finalCostUsd: 0.5, subagentCostUsd: 0, finalTurnCount: 5, closedAt: ts, status: 'succeeded' },
    };

    const acc = new SessionCostAccumulator();
    acc.add(childA!);
    acc.add(childB!);
    acc.add(sealEvent);
    const result = acc.result();

    // closureSum($1+$2=$3) + sealRoot($0.5) = $3.5; last closure has subagentId
    // → rootClosureLost=true.
    expect(result.totalCostUsd).toBeCloseTo(3.5);
    expect(result.rootCostUsd).toBe(0.5);
    expect(result.subagentCostUsd).toBeCloseTo(3);
    expect(result.closureCount).toBe(2);
    expect(result.source).toBe('closures+seal');
    expect(result.totalTokens).toEqual({ input: 30, output: 15 });
  });
});
