/**
 * Tests for the `budget` trace event emitted from
 * {@link transformProviderEvent} when the running session cost crosses
 * `maxBudgetUsd`.
 *
 * Scope: PR #2 commit 5. Budget enforcement itself is covered by
 * `stream-consumer-budget.test.ts`; this file is dedicated to the
 * trace-emission contract.
 *
 * The budget event is the threshold-breach record. It carries the
 * monetary tuple at the moment of breach. The subsequent abort + the
 * later `closure: budget_exceeded` are the termination records — they
 * are validated in their own commits.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProviderEvent, ProviderUsage } from '../provider.js';
import type { Message, SessionMetadata } from '../types.js';
import { transformProviderEvent, type TransformDeps } from '../session/stream-consumer.js';
import { InMemoryTraceWriter } from './writer.js';

function makeSessionMetadata(): SessionMetadata {
  return {
    sessionId: 'test-session',
    model: 'claude-sonnet-5',
    permissionMode: 'default',
  };
}

function makeDeps(opts: {
  maxBudgetUsd?: number;
  abortBudget?: (reason: string) => void;
  traceWriter?: InMemoryTraceWriter;
}): TransformDeps {
  let sessionMeta = makeSessionMetadata();
  const history: Message[] = [];
  return {
    conversationHistory: history,
    getSessionMetadata: () => sessionMeta,
    setSessionMetadata: (updater) => {
      sessionMeta = updater(sessionMeta);
    },
    updateSessionIdentity: vi.fn(),
    resolveInitialization: vi.fn(),
    setLastResponseMetadata: vi.fn(),
    maxBudgetUsd: opts.maxBudgetUsd,
    abortBudget: opts.abortBudget,
    _runningCostUsd: 0,
    ...(opts.traceWriter ? { traceWriter: opts.traceWriter } : {}),
  };
}

function makeTurnCompleted(totalCostUsd: number | undefined): ProviderEvent {
  const usage: ProviderUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    stopReason: 'end_turn',
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
  return { type: 'turn.completed', usage, sessionId: 'test-session' };
}

describe('budget trace event', () => {
  it('emits exactly one monetary budget event when the breach turn lands', async () => {
    const writer = new InMemoryTraceWriter();
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(0.06), deps);
    await new Promise((r) => setImmediate(r));

    const budgets = writer.events.filter((e) => e.kind === 'budget');
    expect(budgets).toHaveLength(1);
    const ev = budgets[0];
    if (ev?.kind !== 'budget') throw new Error('unreachable');
    expect(ev.payload.kind).toBe('monetary');
    expect(ev.payload.runningCostUsd).toBeCloseTo(0.06, 4);
    expect(ev.payload.maxBudgetUsd).toBe(0.05);
    expect(ev.payload.lastTurnCostUsd).toBeCloseTo(0.06, 4);
  });

  it('reports the cumulative runningCostUsd, not just the breach turn', async () => {
    const writer = new InMemoryTraceWriter();
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(0.02), deps);
    transformProviderEvent(makeTurnCompleted(0.02), deps);
    // No budget event yet — cumulative 0.04 < 0.05.
    expect(writer.events.filter((e) => e.kind === 'budget')).toHaveLength(0);

    transformProviderEvent(makeTurnCompleted(0.02), deps);
    await new Promise((r) => setImmediate(r));

    const ev = writer.events.find((e) => e.kind === 'budget');
    if (ev?.kind !== 'budget') throw new Error('expected budget event');
    // Cumulative 0.02 + 0.02 + 0.02 = 0.06 at breach.
    expect(ev.payload.runningCostUsd).toBeCloseTo(0.06, 4);
    expect(ev.payload.lastTurnCostUsd).toBeCloseTo(0.02, 4);
  });

  it('emits BEFORE abortBudget fires (so a fast-cancelling provider cannot drop the record)', async () => {
    const writer = new InMemoryTraceWriter();
    let writerLengthAtAbort = -1;
    const abortBudget = vi.fn(() => {
      writerLengthAtAbort = writer.events.length;
    });
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(0.10), deps);

    // The budget event must already be in the writer at the moment
    // abortBudget runs — the emit happens synchronously from the
    // emission site's perspective before the abort call.
    expect(writerLengthAtAbort).toBeGreaterThanOrEqual(1);
    expect(writer.events[0]?.kind).toBe('budget');
  });

  it('does not emit when maxBudgetUsd is undefined (uncapped session)', async () => {
    const writer = new InMemoryTraceWriter();
    const deps = makeDeps({ traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(1.0), deps);
    transformProviderEvent(makeTurnCompleted(1.0), deps);
    await new Promise((r) => setImmediate(r));

    expect(writer.events).toHaveLength(0);
  });

  it('does not emit when totalCostUsd is undefined (provider does not supply cost)', async () => {
    const writer = new InMemoryTraceWriter();
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.01, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(undefined), deps);
    await new Promise((r) => setImmediate(r));

    expect(writer.events).toHaveLength(0);
    expect(abortBudget).not.toHaveBeenCalled();
  });

  it('does not emit on under-ceiling turns', async () => {
    const writer = new InMemoryTraceWriter();
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 1.0, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(0.10), deps);
    transformProviderEvent(makeTurnCompleted(0.10), deps);
    await new Promise((r) => setImmediate(r));

    expect(writer.events).toHaveLength(0);
    expect(abortBudget).not.toHaveBeenCalled();
  });

  it('boundary: running cost == ceiling emits the budget event', async () => {
    const writer = new InMemoryTraceWriter();
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget, traceWriter: writer });

    transformProviderEvent(makeTurnCompleted(0.05), deps);
    await new Promise((r) => setImmediate(r));

    const ev = writer.events.find((e) => e.kind === 'budget');
    if (ev?.kind !== 'budget') throw new Error('expected budget event');
    expect(ev.payload.runningCostUsd).toBeCloseTo(0.05, 4);
    expect(ev.payload.maxBudgetUsd).toBe(0.05);
    expect(ev.payload.lastTurnCostUsd).toBeCloseTo(0.05, 4);
  });

  it('does nothing when traceWriter is absent (graceful no-op)', async () => {
    const abortBudget = vi.fn();
    const deps = makeDeps({ maxBudgetUsd: 0.05, abortBudget });

    // No throw despite no writer.
    expect(() => transformProviderEvent(makeTurnCompleted(0.10), deps)).not.toThrow();
    expect(abortBudget).toHaveBeenCalledTimes(1);
  });
});
