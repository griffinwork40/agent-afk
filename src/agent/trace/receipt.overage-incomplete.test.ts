/**
 * Subscription-overage completeness (#4883): `cost.overageIncomplete` marks the
 * overage pair as lower bounds when the closure set did not account for the
 * whole session cost, and the session shutdown path carries the accounting
 * accumulator's overage rollup into the emitted closure.
 */
import { describe, expect, it } from 'vitest';
import { SessionShutdown } from '../session/session-shutdown.js';
import { AccountingAccumulator } from '../session/accounting-accumulator.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import type { AgentConfig } from '../types.js';
import { InMemoryTraceWriter } from './writer.js';
import { generateReceipt } from './receipt.js';
import type { TraceEvent } from './types.js';

const META = { tracePath: '/x/w/trace.jsonl', witnessLabel: 'w' };

function closure(finalCostUsd: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: 't', seq: 0, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: 1, finalCostUsd, finalTokens: {}, ...extra } };
}

function seal(finalCostUsd: number, subagentCostUsd: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: 't', seq: 1, kind: 'session_sealed', payload: { reason: 'normal', finalTurnCount: 1, finalCostUsd, subagentCostUsd, ...extra } };
}

function receiptOf(events: Array<Record<string, unknown>>) {
  return generateReceipt(events as unknown as TraceEvent[], META);
}

describe('cost.overageIncomplete (#4883)', () => {
  it('closures-incomplete (root closure never written) flags the pair as lower bounds', () => {
    const r = receiptOf([
      closure(1, { subagentId: 'c1', overageCostUsd: 0.5, overageRequests: 1 }),
      seal(0, 0, { incomplete: true }),
    ]);
    expect(r.cost.costSource).toBe('closures-incomplete');
    expect(r.cost.overageCostUsd).toBe(0.5);
    expect(r.cost.overageRequests).toBe(1);
    expect(r.cost.overageIncomplete).toBe(true);
  });

  it('a lost root closure whose spend comes from the seal flags the pair', () => {
    const r = receiptOf([
      closure(1, { subagentId: 'c1', overageCostUsd: 0.5, overageRequests: 1 }),
      seal(2, 1),
    ]);
    expect(r.cost.costSource).toBe('closures+seal');
    expect(r.cost.totalCostUsd).toBe(3);
    expect(r.cost.overageIncomplete).toBe(true);
  });

  it('a child with no closure whose cost reached seal.subagentCostUsd flags the pair', () => {
    const r = receiptOf([
      closure(2, { overageCostUsd: 2, overageRequests: 4 }),
      seal(2, 1.5),
    ]);
    expect(r.cost.totalCostUsd).toBe(3.5);
    expect(r.cost.overageCostUsd).toBe(2);
    expect(r.cost.overageIncomplete).toBe(true);
  });

  it('a complete closure set does not set the flag', () => {
    const r = receiptOf([
      closure(1, { subagentId: 'c1', overageCostUsd: 0.25, overageRequests: 1 }),
      closure(2, { overageCostUsd: 0.5, overageRequests: 2 }),
      seal(2, 1),
    ]);
    expect(r.cost.costSource).toBe('closures+seal');
    expect(r.cost.overageCostUsd).toBe(0.75);
    expect(r.cost.overageRequests).toBe(3);
    expect(r.cost).not.toHaveProperty('overageIncomplete');
  });

  it('a seal with no closures leaves all three fields absent', () => {
    const r = receiptOf([seal(2, 1)]);
    expect(r.cost.costSource).toBe('seal');
    expect(r.cost).not.toHaveProperty('overageCostUsd');
    expect(r.cost).not.toHaveProperty('overageRequests');
    expect(r.cost).not.toHaveProperty('overageIncomplete');
  });

  it('incomplete closures that carried no overage data leave all three fields absent', () => {
    const r = receiptOf([closure(1, { subagentId: 'c1' }), seal(0, 0, { incomplete: true })]);
    expect(r.cost).not.toHaveProperty('overageCostUsd');
    expect(r.cost).not.toHaveProperty('overageIncomplete');
  });

  it('a clamp that reduces the overage figure flags it', () => {
    const r = receiptOf([closure(1, { overageCostUsd: 5, overageRequests: 3 })]);
    expect(r.cost.overageCostUsd).toBe(1);
    expect(r.cost.overageIncomplete).toBe(true);
  });
});

describe('session shutdown carries the overage rollup into the closure (#4883)', () => {
  async function shutDown(accounting: AccountingAccumulator): Promise<InMemoryTraceWriter> {
    const writer = new InMemoryTraceWriter();
    const shutdown = new SessionShutdown({
      getConfig: () => ({ model: 'sonnet', cwd: '/repo', traceWriter: writer }) as unknown as AgentConfig,
      getAbortController: () => new AbortController(),
      getHookRegistry: () => undefined,
      accounting,
      getTurnCount: () => 2,
      getSessionId: () => 'sess-1',
      ownedTraceWriter: writer,
      ownsTraceSeal: true,
    });
    await shutdown.dispatchOnce('close');
    return writer;
  }

  it('the accumulator overage reaches the closure and a complete receipt', async () => {
    const acc = new AccountingAccumulator();
    acc.recordTurnMetadata(usageToMetadata({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.3, overageCostUsd: 0.3, overageRequests: 1 }, 's'));
    acc.recordTurnMetadata(usageToMetadata({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.2, overageCostUsd: 0, overageRequests: 0 }, 's'));
    const writer = await shutDown(acc);
    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('no closure');
    expect(ev.payload.overageCostUsd).toBeCloseTo(0.3, 12);
    expect(ev.payload.overageRequests).toBe(1);
    const r = generateReceipt(writer.events as TraceEvent[], META);
    expect(r.cost.costSource).toBe('closures+seal');
    expect(r.cost.overageCostUsd).toBeCloseTo(0.3, 12);
    expect(r.cost.overageRequests).toBe(1);
    expect(r.cost).not.toHaveProperty('overageIncomplete');
  });

  it('an unmeasured session emits a closure without the fields', async () => {
    const acc = new AccountingAccumulator();
    acc.recordTurnMetadata(usageToMetadata({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.3 }, 's'));
    const writer = await shutDown(acc);
    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('no closure');
    expect(ev.payload).not.toHaveProperty('overageCostUsd');
    expect(ev.payload).not.toHaveProperty('overageRequests');
  });
});
