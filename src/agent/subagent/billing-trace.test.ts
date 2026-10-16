/**
 * #3878: a child's billing usage is SUMMED across every `done` event of its
 * run (one `done` per turn), handed to the parent's `onSubagentSucceeded`
 * rollup, and stamped on `subagent_lifecycle.succeeded` as `{ provider, tokens }`.
 * The legacy `trace.usage` fields keep their latest-turn semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { SubagentLifecyclePayloadSchema } from '../trace/events.js';
import { usageToMetadata } from '../session/stream-consumer.js';
import { openAICompatibleBilling } from '../usage.billing.js';

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
