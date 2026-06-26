/**
 * Regression test for the "wedged session after a rejected continuation
 * request" bug.
 *
 * Repro: a turn that uses tools pushes its `[assistant(thinking+tool_use),
 * tool_result]` turns into the per-session `messages` array — which is mutated
 * in place and REUSED across turns. If the FOLLOW-UP continuation request is
 * rejected by the API (e.g. a malformed thinking block under interleaved
 * thinking, or any non-retryable 4xx), `loop.ts` yields an `error` event and
 * returns — but those pushed turns are left behind. The loop's own rollback
 * (`messagesRollbackIdx`) only covers throws DURING tool execution, not the
 * NEXT iteration's request failure, and `repairOrphanToolUses` only heals
 * orphan `tool_use` blocks (here the array ends in a MATCHED `tool_result`, so
 * it no-ops). So every later prompt re-sends the same rejected history and
 * re-fails: a permanent session wedge where the user "can't send anything
 * else".
 *
 * The fix truncates the failed turn's pushes back to the known-sendable prefix
 * (history through the triggering user turn) so the next prompt starts from a
 * prefix the API has already accepted.
 *
 * These tests drive the REAL `AnthropicDirectQuery` generator (where the fix
 * lives) directly, mocking `messages.create` to (1) return a tool-use stream,
 * (2) reject the continuation, then (3) capture exactly what the NEXT turn
 * sends. A mock-provider test at the AgentSession layer would NOT catch this.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import { AnthropicDirectQuery } from './query.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { ToolCall, ToolResult } from './types.js';

// --- Mock SDK plumbing ---

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

// --- Helpers ---

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Push-driven prompt stream so we can deliver user turns over the session. */
function createPushStream<T>(): {
  push: (item: T) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
} {
  const queue: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T): void {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: item, done: false });
      } else {
        queue.push(item);
      }
    },
    close(): void {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const head = queue.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
            return new Promise<IteratorResult<T>>((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
  };
}

const baseUsage = () => ({
  input_tokens: 5,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: null,
  service_tier: null,
});

/** Assistant turn with a leading (signed) thinking block followed by tool_use. */
function makeThinkingToolUseStream(toolId: string, toolName: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_tu',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning about the request' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-deadbeef' },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 1 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Plain text turn that ends with stop_reason=end_turn. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_text',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Deep-copy a captured messages array so later in-place mutation cannot bleed in. */
function snapshot(messages: MessageParam[]): MessageParam[] {
  return JSON.parse(JSON.stringify(messages)) as MessageParam[];
}

function hasAssistantToolUse(messages: MessageParam[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.some((b) => (b as { type: string }).type === 'tool_use'),
  );
}

function makeQuery(
  promptStream: AsyncIterable<{ content: string }>,
  dispatcher: ToolDispatcher,
): AnthropicDirectQuery {
  return new AnthropicDirectQuery({
    client: new MockAnthropic() as unknown as Anthropic,
    authMode: 'api-key',
    promptStream,
    toolDispatcher: dispatcher,
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 1024,
    tools: [{ name: 'probe', input_schema: { type: 'object' } }],
    userSystem: null,
    systemPrefix: null,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    // Seed a completed prior exchange: the "known-good" prefix the wedge must
    // never destroy and the rollback must preserve.
    initialMessages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  });
}

// --- Tests ---

describe('AnthropicDirectQuery — recovery from a rejected continuation request', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('does not wedge: a turn whose continuation is rejected leaves the next turn a sendable history', async () => {
    const prompts = createPushStream<{ content: string }>();
    const dispatcher: ToolDispatcher = {
      execute: (_call: ToolCall): Promise<ToolResult> =>
        Promise.resolve({ content: 'tool ran fine' }),
    };

    const sentPerCall: MessageParam[][] = [];
    let callIdx = 0;
    messagesCreateMock.mockImplementation((params: { messages: MessageParam[] }) => {
      callIdx += 1;
      sentPerCall.push(snapshot(params.messages));
      if (callIdx === 1) {
        // Turn 1 request → model emits thinking + a tool_use.
        return fromArray(makeThinkingToolUseStream('toolu_1', 'probe'));
      }
      if (callIdx === 2) {
        // Turn 1 continuation (tool_result already in history) → API rejects it.
        // The message body mentions "thinking" to mirror the real failure mode;
        // any non-retryable error reaches the same yield-error path.
        throw new Error(
          'messages.0: `thinking` blocks in the latest assistant turn were not valid',
        );
      }
      // Turn 2 request → must succeed, proving the session is not wedged.
      return fromArray(makeTextStream('recovered and answered'));
    });

    const query = makeQuery(prompts.iterable, dispatcher);
    const it = (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator]();

    // session.init handshake.
    const init = await it.next();
    expect((init.value as ProviderEvent).type).toBe('session.init');

    // Turn 1 — drive to its terminal event (an `error` from the rejected continuation).
    prompts.push({ content: 'first question' });
    let sawError = false;
    let r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'error') sawError = true;
      // Turn 1 ends when the error event is yielded; loop yields error then the
      // outer generator suspends awaiting the next prompt.
      if (ev.type === 'error' || ev.type === 'turn.completed') break;
      r = await it.next();
    }
    expect(sawError).toBe(true);

    // Turn 2 — the regression: pre-fix, the poisoned [assistant(tool_use),
    // tool_result] turns are still in history, so this request re-sends them.
    prompts.push({ content: 'second question' });
    let assistantText = '';
    let sawTurn2Completed = false;
    r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'delta.text') assistantText += ev.text;
      if (ev.type === 'assistant.message') assistantText = ev.text;
      if (ev.type === 'turn.completed') {
        sawTurn2Completed = true;
        break;
      }
      r = await it.next();
    }

    // The second turn actually ran (3rd model call) and completed.
    expect(callIdx).toBe(3);
    expect(sawTurn2Completed).toBe(true);
    expect(assistantText).toContain('recovered and answered');

    // The decisive assertion: the turn-2 request did NOT re-send the poisoned
    // assistant tool_use turn. Pre-fix this array still contained it and the
    // real API would reject it identically → permanent wedge.
    const turn2Sent = sentPerCall[2]!;
    expect(hasAssistantToolUse(turn2Sent)).toBe(false);
    // It is exactly the known-sendable prefix plus the new user turn:
    // [earlier question, earlier answer, first question, second question].
    expect(turn2Sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);

    prompts.close();
    await it.return?.();
  });

  it('preserves the prior good exchange — rollback truncates only the failed turn', async () => {
    const prompts = createPushStream<{ content: string }>();
    const dispatcher: ToolDispatcher = {
      execute: (_call: ToolCall): Promise<ToolResult> => Promise.resolve({ content: 'ok' }),
    };

    let callIdx = 0;
    const sentPerCall: MessageParam[][] = [];
    messagesCreateMock.mockImplementation((params: { messages: MessageParam[] }) => {
      callIdx += 1;
      sentPerCall.push(snapshot(params.messages));
      if (callIdx === 1) return fromArray(makeThinkingToolUseStream('toolu_a', 'probe'));
      if (callIdx === 2) throw new Error('invalid request: thinking signature mismatch');
      return fromArray(makeTextStream('ok answer'));
    });

    const query = makeQuery(prompts.iterable, dispatcher);
    const it = (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator]();
    await it.next(); // session.init

    prompts.push({ content: 'q1' });
    let r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'error' || ev.type === 'turn.completed') break;
      r = await it.next();
    }

    prompts.push({ content: 'q2' });
    r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'turn.completed') break;
      r = await it.next();
    }

    // The seeded prior exchange survives the rollback (it is part of the
    // known-good prefix), so context is not lost — only the failed turn's
    // partial tool churn is dropped.
    const turn2Sent = sentPerCall[2]!;
    expect(turn2Sent[0]).toMatchObject({ role: 'user', content: 'earlier question' });
    expect(turn2Sent[1]).toMatchObject({ role: 'assistant', content: 'earlier answer' });

    prompts.close();
    await it.return?.();
  });
});
