import { describe, it, expect } from 'vitest';
import { createStreamState, usageFromState, finalizedToolCalls, isToolCallStop } from './translate.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';
import type { ProviderEvent } from '../../provider.js';

const SESSION_ID = 'sess-responses';

function collect(events: ResponsesStreamEvent[]) {
  const state = createStreamState();
  const out: ProviderEvent[] = [];
  for (const e of events) {
    for (const ev of translateResponsesEvent(e, state, SESSION_ID)) {
      out.push(ev);
    }
  }
  return { state, events: out };
}

describe('translateResponsesEvent — text', () => {
  it('emits a delta.text per output_text.delta and accumulates assistantText', () => {
    const { events, state } = collect([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ', ' },
      { type: 'response.output_text.delta', delta: 'world!' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    expect(events).toEqual([
      { type: 'delta.text', text: 'Hello', sessionId: SESSION_ID },
      { type: 'delta.text', text: ', ', sessionId: SESSION_ID },
      { type: 'delta.text', text: 'world!', sessionId: SESSION_ID },
    ]);
    expect(state.assistantText).toBe('Hello, world!');
    expect(state.finishReason).toBe('stop');
    expect(isToolCallStop(state)).toBe(false);
  });

  it('ignores empty text deltas', () => {
    const { events } = collect([{ type: 'response.output_text.delta', delta: '' }]);
    expect(events).toEqual([]);
  });
});

describe('translateResponsesEvent — reasoning', () => {
  it('emits delta.reasoning for both reasoning_text and reasoning_summary_text', () => {
    const { events, state } = collect([
      { type: 'response.reasoning_text.delta', delta: 'think ' },
      { type: 'response.reasoning_summary_text.delta', delta: 'summary' },
    ]);
    expect(events).toEqual([
      { type: 'delta.reasoning', text: 'think ', sessionId: SESSION_ID },
      { type: 'delta.reasoning', text: 'summary', sessionId: SESSION_ID },
    ]);
    expect(state.reasoningText).toBe('think summary');
  });
});

describe('translateResponsesEvent — tool calls', () => {
  it('accumulates a function call from output_item.added + argument deltas (no mid-stream events)', () => {
    const { events, state } = collect([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"NYC"}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    // No events emitted mid-stream for tool calls (harness fires tool.use.start post-turn).
    expect(events).toEqual([]);
    const calls = finalizedToolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ index: 0, id: 'call_abc', name: 'get_weather', argumentsRaw: '{"city":"NYC"}' });
    expect(state.finishReason).toBe('tool_calls');
    expect(isToolCallStop(state)).toBe(true);
  });

  it('handles two parallel tool calls keyed by output_index', () => {
    const { state } = collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'a', arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'b', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":1}' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"y":2}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    const calls = finalizedToolCalls(state);
    expect(calls.map((c) => [c.id, c.name, c.argumentsRaw])).toEqual([
      ['c0', 'a', '{"x":1}'],
      ['c1', 'b', '{"y":2}'],
    ]);
  });

  it('tolerates argument deltas arriving before output_item.added (defensive seeding)', () => {
    const { state } = collect([
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'late', name: 'fn', arguments: '' } },
    ]);
    const calls = finalizedToolCalls(state);
    // The added event refreshes id/name; arguments seeded earlier are NOT clobbered
    // because output_item.added carries empty arguments and we prefer the existing accumulation.
    expect(calls[0]).toMatchObject({ id: 'late', name: 'fn', argumentsRaw: '{"a":1}' });
  });
});

describe('translateResponsesEvent — usage', () => {
  it('maps Responses usage onto the Chat-Completions-shaped state.usage', () => {
    const { state } = collect([
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } },
        },
      },
    ]);
    const usage = usageFromState(state);
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      totalTokens: 120,
      stopReason: 'stop',
      isError: false,
    });
  });

  it('marks response.failed and response.incomplete finish reasons', () => {
    const failed = collect([{ type: 'response.failed', response: { status: 'failed' } }]);
    expect(failed.state.finishReason).toBe('failed');
    const incomplete = collect([
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    expect(incomplete.state.finishReason).toBe('max_output_tokens');
  });
});
