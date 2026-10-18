/**
 * #3878: a child's billing usage is SUMMED across every `done` event of its
 * run (one `done` per turn), handed to the parent's `onSubagentSucceeded`
 * rollup, and stamped on `subagent_lifecycle.succeeded` as `{ provider, tokens }`.
 * The legacy `trace.usage` fields keep their latest-turn semantics. A child
 * that fails or is cancelled still carries `{ provider, tokens }` on its
 * terminal row and lands in `billing.subagents` — billing-only, so the legacy
 * success-only counters are unchanged — exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { SubagentLifecyclePayloadSchema } from '../trace/events.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import { openAICompatibleBilling } from '../usage.billing.js';
import { AccountingAccumulator } from '../session/accounting-accumulator.js';
import { TimeoutError } from '../../utils/errors.js';

/** Each `sendMessageStream` call (one per turn) yields the next event list. */
function mockSession(turns: OutputEvent[][]): IAgentSession {
  let call = 0;
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async *sendMessageStream() {
      for (const e of turns[call++] ?? []) yield e;
    },
    async interrupt() {},
    async close() {},
    getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
    getLastResponseMetadata: () => null,
  } as unknown as IAgentSession;
}

/** A `done` event exactly as stream-consumer would build it for one OpenAI turn. */
const openAIDone = (prompt: number, cached: number, completion: number): OutputEvent => ({
  type: 'done',
  metadata: usageToMetadata(
    {
      inputTokens: prompt,
      cachedInputTokens: cached,
      outputTokens: completion,
      billing: openAICompatibleBilling(prompt, cached, completion),
    },
    'mock-session',
  ),
});

describe('subagent billing across turns', () => {
  it('sums billing over the initial + drain turns, reports it to the parent and the succeeded lifecycle', async () => {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const onSucceeded = vi.fn();
    const final: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const session = mockSession([
      [{ type: 'message', message: final }, openAIDone(10_000, 9_000, 100)],
      [{ type: 'message', message: final }, openAIDone(12_000, 11_000, 50)],
    ]);

    const handle = new SubagentHandleImpl(
      'billing-child', session, controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, onSucceeded,
    );
    // A queued follow-up runs as a drain turn, which replaces `_currentTrace`.
    handle._pendingUserMessages.push('follow-up');
    const result = await handle.runToResult('go');

    // Legacy fields: latest turn only (unchanged semantics).
    expect(result.trace?.usage?.inputTokens).toBe(12_000);
    expect(result.trace?.usage?.cacheReadTokens).toBe(11_000);
    // Billing: summed across both turns, uncached excludes cache reads.
    const expected = { provider: 'openai-compatible', uncachedInput: 2_000, cacheRead: 20_000, cacheWrite: 0, output: 150 };
    expect(result.trace?.usage?.billing).toEqual(expected);

    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(onSucceeded.mock.calls[0]?.[0]?.billing).toEqual(expected);

    const succeeded = writer.events.find(
      (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'succeeded',
    );
    expect(succeeded?.kind).toBe('subagent_lifecycle');
    if (succeeded?.kind !== 'subagent_lifecycle' || succeeded.payload.transition !== 'succeeded') return;
    expect(succeeded.payload.provider).toBe('openai-compatible');
    expect(succeeded.payload.tokens).toEqual({ uncachedInput: 2_000, cacheRead: 20_000, cacheWrite: 0, output: 150 });
    expect(SubagentLifecyclePayloadSchema.safeParse(succeeded.payload).success).toBe(true);
  });

  it('costUsd passed to onSubagentSucceeded is the sum across initial + drain turns, not last turn only (#3882 case 3)', async () => {
    // Regression: previously costUsd was read from lastMsg.metadata.totalCostUsd,
    // which is a per-turn figure — a drained run only reported the FINAL turn's cost.
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const onSucceeded = vi.fn();
    const final: Message = { role: 'assistant', content: 'done', timestamp: new Date() };

    // Two turns: initial ($0.03) + drain ($0.05). Cumulative should be $0.08.
    const doneWithCost = (cost: number): OutputEvent => ({
      type: 'done',
      metadata: usageToMetadata(
        { inputTokens: 1000, outputTokens: 10, totalCostUsd: cost, billing: openAICompatibleBilling(1000, 0, 10) },
        'mock-session',
      ),
    });
    const session = mockSession([
      [{ type: 'message', message: final }, doneWithCost(0.03)],
      [{ type: 'message', message: final }, doneWithCost(0.05)],
    ]);

    const handle = new SubagentHandleImpl(
      'cost-child', session, controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, onSucceeded,
    );
    handle._pendingUserMessages.push('drain-turn');
    await handle.runToResult('go');

    expect(onSucceeded).toHaveBeenCalledTimes(1);
    const [usageArg, reportedCost] = onSucceeded.mock.calls[0]! as [unknown, number | undefined];
    // Must be the sum of both turns, not just the last ($0.05).
    expect(reportedCost).toBeCloseTo(0.08, 10);
    // The billing delta (arg[0]) must reflect both turns summed — each turn
    // contributes uncachedInput=1000, output=10 → two turns = 2000/20.
    expect(usageArg).toMatchObject({
      billing: { provider: 'openai-compatible', uncachedInput: 2000, cacheRead: 0, cacheWrite: 0, output: 20 },
    });
    // Token-level context.total accumulation: inputTokens from both turns.
    expect(usageArg).toMatchObject({ inputTokens: 1000, outputTokens: 10 });
  });

  it('a child whose provider reports no billing keeps the succeeded payload byte-compatible', async () => {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const final: Message = { role: 'assistant', content: 'ok', timestamp: new Date() };
    const session = mockSession([
      [{ type: 'message', message: final }, { type: 'done', metadata: { usage: { input_tokens: 5, output_tokens: 1 } } }],
    ]);
    const handle = new SubagentHandleImpl(
      'legacy-child', session, controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, vi.fn(),
    );
    const result = await handle.runToResult('go');
    expect(result.trace?.usage).toEqual({ inputTokens: 5, outputTokens: 1, cacheReadTokens: undefined, cacheCreationTokens: undefined });
    const succeeded = writer.events.find(
      (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'succeeded',
    );
    if (succeeded?.kind !== 'subagent_lifecycle') throw new Error('no succeeded event');
    expect('tokens' in succeeded.payload).toBe(false);
    expect('provider' in succeeded.payload).toBe(false);
  });
});

/**
 * A one-turn session that yields a billed `done` with NO assistant message.
 * `before` runs first (e.g. abort/cancel), so the turn's spend lands after it.
 */
function billedNoMessage(before?: () => void): IAgentSession {
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async *sendMessageStream() {
      before?.();
      yield openAIDone(10_000, 9_000, 100);
    },
    async interrupt() {},
    async close() {},
    getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
    getLastResponseMetadata: () => null,
  } as unknown as IAgentSession;
}

describe('subagent billing on unsuccessful terminations', () => {
  const expectedTokens = { uncachedInput: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100 };

  /** Build a handle wired to a REAL accumulator, exactly as surfaces wire it. */
  function harness(before?: (h: { handle: SubagentHandleImpl<unknown>; controller: AbortController }) => void) {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const acc = new AccountingAccumulator();
    const onSucceeded = vi.fn((usage: Parameters<AccountingAccumulator['recordSubagentCompletion']>[0], cost: number | undefined) =>
      acc.recordSubagentCompletion(usage, cost),
    );
    const ref: { handle?: SubagentHandleImpl<unknown> } = {};
    const handle: SubagentHandleImpl<unknown> = new SubagentHandleImpl(
      'child', billedNoMessage(before ? () => before({ handle: ref.handle!, controller }) : undefined),
      controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, onSucceeded,
    );
    ref.handle = handle;
    const terminal = (transition: string) =>
      writer.events.filter((e) => e.kind === 'subagent_lifecycle' && e.payload.transition === transition);
    return { handle, controller, writer, acc, onSucceeded, terminal };
  }

  /** Legacy counters stay success-only; billing.subagents carries the spend. */
  function expectBillingOnlyRollup(acc: AccountingAccumulator): void {
    const snap = acc.snapshot();
    expect(snap.subagentCompletedCount).toBe(0);
    expect(snap.subagentRunningTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(snap.subagentRunningCostUsd).toBe(0);
    expect(snap.subagentBilling).toEqual({
      total: expectedTokens,
      byProvider: { 'openai-compatible': expectedTokens },
    });
  }

  it('failed child (billed turn, zero output): row carries tokens; billing-only rollup', async () => {
    const h = harness();
    await expect(h.handle.run('go')).rejects.toThrow(/produced no output/);
    const rows = h.terminal('failed');
    expect(rows).toHaveLength(1);
    const [failed] = rows;
    if (failed?.kind !== 'subagent_lifecycle' || failed.payload.transition !== 'failed') throw new Error('no failed row');
    expect(failed.payload.provider).toBe('openai-compatible');
    expect(failed.payload.tokens).toEqual(expectedTokens);
    expect(SubagentLifecyclePayloadSchema.safeParse(failed.payload).success).toBe(true);
    expect(h.onSucceeded).toHaveBeenCalledTimes(1);
    expectBillingOnlyRollup(h.acc);
  });

  it('cascade-cancelled child: cascade row carries tokens; billing-only rollup', async () => {
    const h = harness(({ controller }) => controller.abort());
    await expect(h.handle.run('go')).rejects.toThrow();
    const rows = h.terminal('cancelled');
    expect(rows).toHaveLength(1);
    const [cancelled] = rows;
    if (cancelled?.kind !== 'subagent_lifecycle' || cancelled.payload.transition !== 'cancelled') throw new Error('no row');
    expect(cancelled.payload.source).toBe('cascade');
    expect(cancelled.payload.provider).toBe('openai-compatible');
    expect(cancelled.payload.tokens).toEqual(expectedTokens);
    expect(SubagentLifecyclePayloadSchema.safeParse(cancelled.payload).success).toBe(true);
    expect(h.terminal('failed')).toHaveLength(0);
    expect(h.onSucceeded).toHaveBeenCalledTimes(1);
    expectBillingOnlyRollup(h.acc);
  });

  it('explicitly cancelled child: spend drained after cancel() still reaches the rollup once', async () => {
    const h = harness(({ handle }) => void handle.cancel());
    await expect(h.handle.run('go')).rejects.toThrow();
    await h.handle._pendingCancellationWrite;
    const rows = h.terminal('cancelled');
    expect(rows).toHaveLength(1);
    const [cancelled] = rows;
    if (cancelled?.kind !== 'subagent_lifecycle' || cancelled.payload.transition !== 'cancelled') throw new Error('no row');
    expect(cancelled.payload.source).toBe('explicit');
    expect(h.onSucceeded).toHaveBeenCalledTimes(1);
    expectBillingOnlyRollup(h.acc);
  });

  it('own wall-clock timeout: the aborted turn\'s billed done, arriving after run() settled, reaches the rollup once (#3889)', async () => {
    // Real ordering, no manual settlement: withTimeout aborts the controller
    // and rejects the race in the same tick, so run()'s catch settles
    // (nothing accrued yet) BEFORE the provider yields the aborted turn's
    // billed `done`. Only the processDoneEvent settlement point catches it.
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const acc = new AccountingAccumulator();
    const onSucceeded = vi.fn(
      (usage: Parameters<AccountingAccumulator['recordSubagentCompletion']>[0], cost: number | undefined) =>
        acc.recordSubagentCompletion(usage, cost),
    );
    let lateDoneYielded = false;
    const session: IAgentSession = {
      sessionId: 'timeout-test',
      state: 'idle',
      abortSignal: new AbortController().signal,
      async *sendMessageStream() {
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        // Provider unwind after abort: a macrotask later, the turn's usage arrives.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        lateDoneYielded = true;
        yield openAIDone(10_000, 9_000, 100);
      },
      async interrupt() {},
      async close() {},
      getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
      getLastResponseMetadata: () => null,
    } as unknown as IAgentSession;

    const handle: SubagentHandleImpl<unknown> = new SubagentHandleImpl(
      'timeout-child', session, controller, graph, undefined, 20, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, onSucceeded,
    );

    await expect(handle.run('go')).rejects.toBeInstanceOf(TimeoutError);
    // run() has already settled; the late done has not arrived yet.
    expect(lateDoneYielded).toBe(false);
    await vi.waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1), { timeout: 500 });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(onSucceeded.mock.calls[0]?.[0]).toMatchObject({ outcome: 'failed', billing: expectedTokens });
    const snap = acc.snapshot();
    expect(snap.subagentCompletedCount).toBe(0);
    expect(snap.subagentBilling).toEqual({
      total: expectedTokens,
      byProvider: { 'openai-compatible': expectedTokens },
    });
  });

  it('explicit cancel() of an in-flight run that already accrued billing: row carries tokens', async () => {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const handle = new SubagentHandleImpl(
      'mid', billedNoMessage(), controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, vi.fn(),
    );
    handle._currentStatus = 'running';
    handle._runBilling = openAICompatibleBilling(10_000, 9_000, 100);
    await handle.cancel();
    await handle._pendingCancellationWrite;
    const row = writer.events.find((e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled');
    if (row?.kind !== 'subagent_lifecycle' || row.payload.transition !== 'cancelled') throw new Error('no row');
    expect(row.payload.tokens).toEqual(expectedTokens);
    expect(row.payload.provider).toBe('openai-compatible');
  });

  it('cancel() after a successful run never double-counts billing', async () => {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const acc = new AccountingAccumulator();
    const final: Message = { role: 'assistant', content: 'ok', timestamp: new Date() };
    const handle = new SubagentHandleImpl(
      'ok-child', mockSession([[{ type: 'message', message: final }, openAIDone(10_000, 9_000, 100)]]),
      controller, graph, undefined, 5000, undefined, vi.fn(), undefined, undefined, undefined, undefined, undefined,
      writer, (u, c) => acc.recordSubagentCompletion(u, c),
    );
    await handle.run('go');
    await handle.cancel();
    await handle._pendingCancellationWrite;
    const cancelled = writer.events.find((e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled');
    if (cancelled?.kind !== 'subagent_lifecycle') throw new Error('no cancelled row');
    expect('tokens' in cancelled.payload).toBe(false);
    const snap = acc.snapshot();
    expect(snap.subagentCompletedCount).toBe(1);
    expect(snap.subagentBilling?.total).toEqual(expectedTokens);
  });
});

/**
 * Exactly-once BY AMOUNT (#3878): a cancel() that settles billing already on
 * the handle must not swallow spend that lands after it. Turn 1 = (10k, 9k
 * cached, 100 out); turn 2 = (12k, 11k cached, 50 out).
 */
describe('subagent billing settled by amount across a cancel', () => {
  const turn1 = { uncachedInput: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100 };
  const sum = { uncachedInput: 2_000, cacheRead: 20_000, cacheWrite: 0, output: 150 };

  function wired(session: (ref: { handle?: SubagentHandleImpl<unknown> }) => IAgentSession) {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const acc = new AccountingAccumulator();
    const onSucceeded = vi.fn((usage: Parameters<AccountingAccumulator['recordSubagentCompletion']>[0], cost: number | undefined) =>
      acc.recordSubagentCompletion(usage, cost),
    );
    const ref: { handle?: SubagentHandleImpl<unknown> } = {};
    const handle: SubagentHandleImpl<unknown> = new SubagentHandleImpl(
      'amt-child', session(ref), controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, onSucceeded,
    );
    ref.handle = handle;
    const rows = (transition: string) =>
      writer.events.filter((e) => e.kind === 'subagent_lifecycle' && e.payload.transition === transition);
    return { handle, acc, onSucceeded, rows };
  }

  it('drain turn: billing before cancel() + a billed `done` after it sums once', async () => {
    const final: Message = { role: 'assistant', content: 'first', timestamp: new Date() };
    let call = 0;
    const h = wired((ref) => ({
      sessionId: 'mock-session',
      state: 'idle',
      abortSignal: new AbortController().signal,
      async *sendMessageStream() {
        if (call++ === 0) {
          yield { type: 'message', message: final } as OutputEvent;
          yield openAIDone(10_000, 9_000, 100);
          return;
        }
        // Drain turn: the cancel lands while turn-1 billing is on the handle,
        // then this turn's spend arrives.
        void ref.handle!.cancel();
        yield openAIDone(12_000, 11_000, 50);
      },
      async interrupt() {},
      async close() {},
      getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
      getLastResponseMetadata: () => null,
    }) as unknown as IAgentSession);
    h.handle._pendingUserMessages.push('follow-up');
    await h.handle.run('go');
    await h.handle._pendingCancellationWrite;

    // The cancelled row carries what was known at cancel time (turn 1 only).
    const [cancelled] = h.rows('cancelled');
    if (cancelled?.kind !== 'subagent_lifecycle' || cancelled.payload.transition !== 'cancelled') throw new Error('no row');
    expect(cancelled.payload.tokens).toEqual(turn1);
    // Two reports — the cancel's turn-1 settlement and the success delta.
    expect(h.onSucceeded).toHaveBeenCalledTimes(2);
    const snap = h.acc.snapshot();
    expect(snap.subagentBilling?.total).toEqual(sum);
    expect(snap.subagentCompletedCount).toBe(1);
    // Legacy counters keep their latest-turn semantics, untouched by billing.
    expect(snap.subagentRunningTokens.input).toBe(12_000);
  });

  it("run()'s post-cancel catch branch reports only the post-cancel delta", async () => {
    const h = wired((ref) => ({
      sessionId: 'mock-session',
      state: 'idle',
      abortSignal: new AbortController().signal,
      async *sendMessageStream() {
        // Spend already on the handle when cancel() settles it.
        ref.handle!._runBilling = openAICompatibleBilling(10_000, 9_000, 100);
        void ref.handle!.cancel();
        yield openAIDone(12_000, 11_000, 50);
      },
      async interrupt() {},
      async close() {},
      getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
      getLastResponseMetadata: () => null,
    }) as unknown as IAgentSession);
    await expect(h.handle.run('go')).rejects.toThrow();
    await h.handle._pendingCancellationWrite;

    expect(h.rows('cancelled')).toHaveLength(1);
    expect(h.rows('failed')).toHaveLength(0);
    const calls = h.onSucceeded.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ outcome: 'cancelled', billing: { ...turn1, provider: 'openai-compatible' } });
    expect(calls[1]).toMatchObject({
      outcome: 'cancelled',
      billing: { uncachedInput: 1_000, cacheRead: 11_000, cacheWrite: 0, output: 50 },
    });
    const snap = h.acc.snapshot();
    expect(snap.subagentBilling?.total).toEqual(sum);
    expect(snap.subagentCompletedCount).toBe(0);
  });

  it('cancel() after a multi-turn success reports nothing more (no double count)', async () => {
    const final: Message = { role: 'assistant', content: 'ok', timestamp: new Date() };
    const h = wired(() => mockSession([
      [{ type: 'message', message: final }, openAIDone(10_000, 9_000, 100)],
      [{ type: 'message', message: final }, openAIDone(12_000, 11_000, 50)],
    ]));
    h.handle._pendingUserMessages.push('follow-up');
    await h.handle.run('go');
    await h.handle.cancel();
    await h.handle._pendingCancellationWrite;
    const [cancelled] = h.rows('cancelled');
    if (cancelled?.kind !== 'subagent_lifecycle') throw new Error('no cancelled row');
    expect('tokens' in cancelled.payload).toBe(false);
    expect(h.onSucceeded).toHaveBeenCalledTimes(1);
    expect(h.acc.snapshot().subagentBilling?.total).toEqual(sum);
  });
});

describe('billing_settled phase on post-cancel delta (#3931)', () => {
  it('emits billing_settled when a billed done arrives after cancel() row was written', async () => {
    // Mirrors "run()'s post-cancel catch branch reports only the post-cancel delta"
    // but checks the trace for the new billing_settled session_phase event.
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    const ref: { handle?: SubagentHandleImpl<unknown> } = {};
    const handle: SubagentHandleImpl<unknown> = new SubagentHandleImpl(
      'phase-child',
      {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: new AbortController().signal,
        async *sendMessageStream() {
          // Spend already on the handle when cancel() settles it.
          ref.handle!._runBilling = openAICompatibleBilling(10_000, 9_000, 100);
          void ref.handle!.cancel();
          // Post-cancel spend delta.
          yield openAIDone(12_000, 11_000, 50);
        },
        async interrupt() {},
        async close() {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        getLastResponseMetadata: () => null,
      } as unknown as IAgentSession,
      controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, vi.fn(),
    );
    ref.handle = handle;
    await expect(handle.run('go')).rejects.toThrow();
    await handle._pendingCancellationWrite;

    // Exactly one cancelled lifecycle row (from cancel()).
    const cancelled = writer.events.filter(
      (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled',
    );
    expect(cancelled).toHaveLength(1);

    // The post-cancel delta must appear as a billing_settled session_phase.
    const settled = writer.events.find(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'billing_settled',
    );
    expect(settled).toBeDefined();
    if (settled?.kind !== 'session_phase') throw new Error('no billing_settled event');
    expect(settled.payload.metadata?.['subagentId']).toBe('phase-child');
    expect(settled.payload.metadata?.['provider']).toBe('openai-compatible');
    // billing_settled carries billingLifecycleFields(context.total) — the
    // cumulative total across both turns (the delta from cancel()'s watermark
    // is computed by the rollup consumer by diffing against the cancelled row).
    // Turn 1: (10k, 9k cached, 100 out) = { uncachedInput: 1k, cacheRead: 9k, output: 100 }
    // Turn 2 cumulative: (22k total, 20k cached, 150 out) = { uncachedInput: 2k, cacheRead: 20k, output: 150 }
    expect(settled.payload.metadata?.['uncachedInput']).toBe(2_000);
    expect(settled.payload.metadata?.['cacheRead']).toBe(20_000);
    expect(settled.payload.metadata?.['output']).toBe(150);
  });

  it('does NOT emit billing_settled when there is no post-cancel delta', async () => {
    const graph = new AbortGraph();
    const controller = new AbortController();
    graph.register('root', controller);
    const writer = new InMemoryTraceWriter();
    // cancel() before any spend — no delta possible.
    const handle = new SubagentHandleImpl(
      'no-delta-child',
      {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: new AbortController().signal,
        async *sendMessageStream() {
          void handle.cancel();
          // No done event — stream ends with no billing.
        },
        async interrupt() {},
        async close() {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        getLastResponseMetadata: () => null,
      } as unknown as IAgentSession,
      controller, graph, undefined, 5000, undefined, vi.fn(),
      undefined, undefined, undefined, undefined, undefined, writer, vi.fn(),
    );
    await expect(handle.run('go')).rejects.toThrow();
    await handle._pendingCancellationWrite;

    const settled = writer.events.find(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'billing_settled',
    );
    expect(settled).toBeUndefined();
  });
});
