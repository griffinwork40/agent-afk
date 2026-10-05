/**
 * Test harness helpers for the anthropic-direct provider in conformance tests.
 *
 * Uses the direct `AnthropicDirectQuery` constructor with a mock Anthropic
 * client — the same pattern the existing loop.*.test.ts suite uses.
 *
 * @module conformance/__test-utils__/anthropic-harness
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { vi } from 'vitest';
import { AnthropicDirectQuery } from '../../anthropic-direct/query-runtime.js';
import type { ProviderEvent, ProviderUserTurn } from '../../../provider.js';

export type { RawMessageStreamEvent };

// ---------------------------------------------------------------------------
// Stream-event helpers — Anthropic SSE shapes
// ---------------------------------------------------------------------------

function baseUsage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** Minimal text-only Anthropic SSE stream ending with `end_turn`. */
export function makeAnthropicTextStream(
  text: string,
  stopReason = 'end_turn',
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_conf_text',
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
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Minimal tool-use Anthropic SSE stream, stop_reason `tool_use`. */
export function makeAnthropicToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_conf_tool',
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
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

// ---------------------------------------------------------------------------
// Mock Anthropic client builder
// ---------------------------------------------------------------------------

export type AnthropicScript =
  | RawMessageStreamEvent[]
  | (() => AsyncIterable<RawMessageStreamEvent>)
  | Error;

/** Build a mock Anthropic client whose `messages.create` plays back `scripts` in order. */
export function makeAnthropicClient(scripts: AnthropicScript[]): {
  client: Anthropic;
  callCount: () => number;
} {
  let idx = 0;
  let callCount = 0;

  const create = vi.fn((_params: unknown, opts?: unknown) => {
    callCount++;
    const script = scripts[idx++];
    if (!script) throw new Error('AnthropicHarness: no more scripted turns');

    if (script instanceof Error) throw script;

    // Accept a signal from the second argument so the mock honours abort.
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;

    if (typeof script === 'function') {
      return script();
    }

    // Array of events — play them back as an async iterable.
    const events = script;
    return (async function* () {
      for (const ev of events) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    })();
  });

  const client = { messages: { create } } as unknown as Anthropic;
  return { client, callCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Query factory
// ---------------------------------------------------------------------------

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

/** Collect all ProviderEvents from an async iterable. */
export async function collectEvents(
  gen: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

export interface AnthropicHarnessOpts {
  /** Scripted responses in order (arrays = stream events, function = custom async iterable, Error = throw). */
  scripts: AnthropicScript[];
  /** The user prompt to send. Defaults to 'hi'. */
  prompt?: string;
  /** Tool dispatcher (no-op by default). */
  toolDispatcher?: import('../../anthropic-direct/tool-dispatcher.js').ToolDispatcher;
}

const noopDispatcher = {
  execute: async () => ({ content: 'ok' }),
};

/**
 * Build an AnthropicDirectQuery with a scripted mock client and run it to
 * completion, returning all emitted ProviderEvents.
 */
export async function runAnthropicScenario(
  opts: AnthropicHarnessOpts,
): Promise<{ events: ProviderEvent[]; callCount: number }> {
  const { client, callCount } = makeAnthropicClient(opts.scripts);
  const query = new AnthropicDirectQuery({
    client,
    authMode: 'api-key',
    promptStream: singleInput(opts.prompt ?? 'hi'),
    toolDispatcher: opts.toolDispatcher ?? noopDispatcher,
    model: 'claude-test',
    maxTokens: 1024,
    tools: null,
    userSystem: null,
    systemPrefix: null,
  });
  const events = await collectEvents(query);
  return { events, callCount: callCount() };
}
