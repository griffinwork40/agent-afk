// Shared test helpers/fixtures for the loop.*.test.ts sibling suites.
// Extracted verbatim from loop.test.ts when it was split (#370).
// This file intentionally does NOT match the vitest test glob (*.test.ts).

import { vi } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import type {
  AnthropicClientLike,
  ToolDispatcherLike,
  ToolCall,
  ToolResult,
  TranslateCtx,
} from './types.js';

// --- Helpers ---

export async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

export async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

export const SESSION_ID = 'sess_loop_test';
export const ctx: TranslateCtx = { sessionId: SESSION_ID };

export function baseUsage(): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
} {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function makeTextStream(text: string, stopReason: string = 'end_turn'): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
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
      content_block: { type: 'text', text: '' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

export function makeToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_t',
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
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

export function makeMultiToolUseStream(
  tools: Array<{ id: string; name: string; input: string }>,
): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_multi',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
  ];

  tools.forEach((tool, idx) => {
    events.push({
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    } as unknown as RawMessageStreamEvent);
    events.push({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'input_json_delta', partial_json: tool.input },
    } as unknown as RawMessageStreamEvent);
    events.push({
      type: 'content_block_stop',
      index: idx,
    } as unknown as RawMessageStreamEvent);
  });

  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 10 },
  } as unknown as RawMessageStreamEvent);
  events.push({ type: 'message_stop' } as unknown as RawMessageStreamEvent);

  return events;
}

export function makeClient(
  streamFactory: () => AsyncIterable<RawMessageStreamEvent>,
): AnthropicClientLike {
  return {
    messages: {
      create: vi.fn(() => streamFactory()),
    },
  };
}

export function makeDispatcher(
  executeFn: (call: ToolCall) => Promise<ToolResult>,
): ToolDispatcherLike {
  return { execute: executeFn };
}

export function makeBatchDispatcher(
  executeBatchFn: (calls: ToolCall[]) => Promise<ToolResult[]>,
): ToolDispatcherLike {
  return {
    execute: vi.fn(() => Promise.reject(new Error('should use batch'))),
    executeBatch: executeBatchFn,
  };
}
