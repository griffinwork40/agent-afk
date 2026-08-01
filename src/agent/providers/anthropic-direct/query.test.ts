/**
 * Parity test for issue #634. `AnthropicDirectQueryOptions.subagentId` (a
 * constructor option) must thread through the private `this.subagentId`
 * field into every per-turn `RunTurnInput.subagentId` (query.ts:437). This
 * is the CLASS-level hop (option → RunTurnInput); the LOOP-level hop
 * (RunTurnInput.subagentId → emitted tool_call trace event) is already
 * covered by loop.trace.test.ts's "tags tool_call started+completed with
 * subagentId when the loop runs inside a fork". Mirrors the openai-compatible
 * side's `query.test.ts` — "tags tool_call events with config.subagentId
 * when running inside a fork".
 */

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import { AnthropicDirectQuery } from './query.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';

// ---- helpers ----------------------------------------------------------

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Minimal tool_use stream: one tool_use block, stop_reason `tool_use`. */
function makeToolUseStream(toolId: string, toolName: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Minimal text-only stream that ends the turn, stop_reason `end_turn`. */
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
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

/**
 * Stub Anthropic client whose `messages.create` returns a scripted
 * tool_use → text turn (never touches the network). First call emits a
 * `bash` tool_use so the loop dispatches a tool (and emits tool_call trace
 * events); the second call ends the turn with plain text.
 */
function makeStubClient(): Anthropic {
  let callIdx = 0;
  const streams = [
    () => fromArray(makeToolUseStream('tu_1', 'bash')),
    () => fromArray(makeTextStream('done')),
  ];
  return {
    messages: { create: vi.fn(() => streams[callIdx++ % streams.length]!()) },
  } as unknown as Anthropic;
}

const okDispatcher: ToolDispatcher = {
  async execute() {
    return { content: 'ok', isError: false };
  },
};

describe('AnthropicDirectQuery — opts.subagentId threading into RunTurnInput (#634)', () => {
  it('tags tool_call trace events with subagentId when constructed inside a fork', async () => {
    const writer = new InMemoryTraceWriter();
    const query = new AnthropicDirectQuery({
      client: makeStubClient(),
      authMode: 'api-key',
      promptStream: singleInput('run the suite'),
      toolDispatcher: okDispatcher,
      model: 'claude-test',
      maxTokens: 1024,
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
      userSystem: null,
      systemPrefix: null,
      traceWriter: writer,
      subagentId: 'research-agent-1700000000000-3',
    });

    await collect(query);
    // Drain microtasks so the fire-and-forget emitToolCall calls settle.
    await new Promise((resolve) => setImmediate(resolve));

    const toolCalls = writer.events.filter((e) => e.kind === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    for (const tc of toolCalls) {
      if (tc.kind !== 'tool_call') throw new Error('unreachable');
      expect(tc.payload.subagentId).toBe('research-agent-1700000000000-3');
    }
  });

  it('omits subagentId from tool_call trace events when opts.subagentId is absent (top-level session)', async () => {
    const writer = new InMemoryTraceWriter();
    const query = new AnthropicDirectQuery({
      client: makeStubClient(),
      authMode: 'api-key',
      promptStream: singleInput('run the suite'),
      toolDispatcher: okDispatcher,
      model: 'claude-test',
      maxTokens: 1024,
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
      userSystem: null,
      systemPrefix: null,
      traceWriter: writer,
      // subagentId omitted intentionally — this is a top-level session.
    });

    await collect(query);
    await new Promise((resolve) => setImmediate(resolve));

    const toolCalls = writer.events.filter((e) => e.kind === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    for (const tc of toolCalls) {
      if (tc.kind !== 'tool_call') throw new Error('unreachable');
      // The key must be ABSENT (not present-with-undefined), matching the
      // absent-key-on-root-session contract in buildToolCallStartedPayload /
      // buildToolCallCompletedPayload (providers/shared/tool-call-trace.ts).
      expect('subagentId' in tc.payload).toBe(false);
    }
  });
});
