/**
 * Subscription-overage cost, end to end (#4883): response headers observed by
 * the tracker -> per-round cost in the anthropic-direct loop -> turn metadata
 * -> session accounting -> `closure` event -> `computeSessionCost` -> receipt.
 */
import { describe, expect, it } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { runTurn } from '../providers/anthropic-direct/loop.js';
import { OverageTracker } from '../providers/anthropic-direct/overage-tracker.js';
import { toProviderUsage } from '../providers/anthropic-direct/usage.js';
import type { AnthropicClientLike } from '../providers/anthropic-direct/types.js';
import { collect, ctx, fromArray, makeDispatcher, makeTextStream, makeToolUseStream } from '../providers/anthropic-direct/loop.test-helpers.js';
import type { ProviderEvent } from '../provider.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import { AccountingAccumulator } from '../session/accounting-accumulator.js';
import { emitClosureEvent, type ClosureSignals } from '../session/closure-emitter.js';
import { InMemoryTraceWriter } from './writer.js';
import { generateReceipt } from './receipt.js';
import type { TraceEvent } from './types.js';

const MODEL = 'claude-sonnet-4-6';
const P = 'anthropic-ratelimit-unified-';
const OVER = { [`${P}status`]: 'rejected', [`${P}overage-status`]: 'allowed', [`${P}representative-claim`]: 'five_hour' };
const UNDER = { [`${P}status`]: 'allowed', [`${P}overage-status`]: 'allowed', [`${P}representative-claim`]: 'five_hour' };

/** One round's cost exactly as the loop computes it (baseUsage, output 9 or 5). */
function roundCost(outputTokens: number): number {
  const u = { input_tokens: 10, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return toProviderUsage(u as never, 'end_turn', MODEL).totalCostUsd!;
}

/**
 * Run one turn of N rounds (tool_use rounds then a final text round). Each
 * `create` call first feeds `headers[i]` to the tracker, as the tracing fetch
 * does when the HTTP response arrives, then streams.
 */
async function runRounds(tracker: OverageTracker | undefined, headers: Array<Record<string, string> | null>): Promise<ProviderEvent> {
  let i = 0;
  const client: AnthropicClientLike = {
    messages: {
      create: () => {
        const idx = i++;
        const hv = headers[idx];
        if (hv) tracker?.observe(new Headers(hv));
        const last = idx === headers.length - 1;
        return fromArray<RawMessageStreamEvent>(last ? makeTextStream('done') : makeToolUseStream(`toolu_${idx}`, 'read_file', '{}'));
      },
    },
  };
  const events = await collect(runTurn({
    client, messages: [{ role: 'user', content: 'go' }], system: null, tools: null,
    toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
    model: MODEL, maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
    ...(tracker ? { overageTracker: tracker } : {}),
  }));
  const done = events.find((e) => e.type === 'turn.completed');
  if (!done) throw new Error('no turn.completed');
  return done;
}

const signals: ClosureSignals = {
  dispatchReason: 'close', signal: new AbortController().signal,
  maxTurnsHit: false, hookBlocked: false, lastStopReason: undefined, sawProviderError: false,
};

/** Fold a turn into a fresh session accumulator and emit its closure. */
async function closeSession(writer: InMemoryTraceWriter, done: ProviderEvent, subagentId?: string): Promise<void> {
  if (done.type !== 'turn.completed') throw new Error('bad event');
  const acc = new AccountingAccumulator();
  acc.recordTurnMetadata(usageToMetadata(done.usage, 's'));
  const snap = acc.snapshot();
  await emitClosureEvent(writer, {
    ...signals, finalTurnCount: 1, finalCostUsd: snap.sessionRunningCostUsd,
    runningTokens: snap.sessionRunningTokens,
    ...(snap.sessionOverage !== undefined ? { overage: snap.sessionOverage } : {}),
    ...(subagentId !== undefined ? { subagentId } : {}),
  });
}

function receiptOf(writer: InMemoryTraceWriter) {
  return generateReceipt(writer.events as TraceEvent[], { tracePath: '/x/w/trace.jsonl', witnessLabel: 'w' });
}

describe('overage cost end to end (#4883)', () => {
  it('reports exactly the flagged responses cost, root plus subagent', async () => {
    const w = new InMemoryTraceWriter();
    // Root: 3 rounds, the middle tool round flagged.
    const root = await runRounds(new OverageTracker(), [UNDER, OVER, UNDER]);
    // Subagent (its own session and tracker): 2 rounds, the final text round flagged.
    const child = await runRounds(new OverageTracker(), [UNDER, OVER]);
    await closeSession(w, child, 'child-1');
    await closeSession(w, root);
    const r = receiptOf(w);
    const expected = roundCost(9) + roundCost(5);
    expect(r.cost.overageRequests).toBe(2);
    expect(r.cost.overageCostUsd).toBeCloseTo(expected, 12);
    expect(r.cost.overageCostUsd!).toBeLessThan(r.cost.totalCostUsd!);
    expect(r.cost.totalCostUsd).toBeCloseTo(3 * roundCost(9) + 2 * roundCost(5), 12);
  });

  it('measured with no overage reports 0 and 0', async () => {
    const w = new InMemoryTraceWriter();
    await closeSession(w, await runRounds(new OverageTracker(), [UNDER, UNDER]));
    const r = receiptOf(w);
    expect(r.cost.overageCostUsd).toBe(0);
    expect(r.cost.overageRequests).toBe(0);
  });

  it('an API key session (no unified headers) has no fields', async () => {
    const w = new InMemoryTraceWriter();
    await closeSession(w, await runRounds(new OverageTracker(), [null, null]));
    const r = receiptOf(w);
    expect(r.cost).not.toHaveProperty('overageCostUsd');
    expect(r.cost).not.toHaveProperty('overageRequests');
  });

  it('a non-Anthropic subagent (no tracker) contributes nothing and does not create the fields', async () => {
    const w = new InMemoryTraceWriter();
    await closeSession(w, await runRounds(undefined, [OVER, OVER]), 'other-provider');
    await closeSession(w, await runRounds(new OverageTracker(), [null]));
    const r = receiptOf(w);
    expect(r.cost).not.toHaveProperty('overageCostUsd');
    expect(r.cost.totalCostUsd).toBeGreaterThan(0);
  });

  it('a non-Anthropic subagent next to a measured root leaves the root figure untouched', async () => {
    const w = new InMemoryTraceWriter();
    await closeSession(w, await runRounds(undefined, [OVER]), 'other-provider');
    await closeSession(w, await runRounds(new OverageTracker(), [OVER]));
    const r = receiptOf(w);
    expect(r.cost.overageRequests).toBe(1);
    expect(r.cost.overageCostUsd).toBeCloseTo(roundCost(5), 12);
  });

  it('an old trace (closures without the fields) yields no fields', () => {
    const events = [
      { ts: 't', seq: 0, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: 1, finalCostUsd: 2, finalTokens: {} } },
    ] as unknown as TraceEvent[];
    const r = generateReceipt(events, { tracePath: '/x/w/trace.jsonl', witnessLabel: 'w' });
    expect(r.cost.totalCostUsd).toBe(2);
    expect(r.cost).not.toHaveProperty('overageCostUsd');
    expect(r.cost).not.toHaveProperty('overageRequests');
  });

  it('never reports more overage than the session total', () => {
    const events = [
      { ts: 't', seq: 0, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: 1, finalCostUsd: 1, finalTokens: {}, overageCostUsd: 5, overageRequests: 3 } },
    ] as unknown as TraceEvent[];
    const r = generateReceipt(events, { tracePath: '/x/w/trace.jsonl', witnessLabel: 'w' });
    expect(r.cost.overageCostUsd).toBe(1);
  });
});
