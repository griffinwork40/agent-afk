/**
 * Translation layer tests. Drives synthetic OpenAI chunks against the
 * accumulator and verifies the emitted ProviderEvent stream + final state.
 * No SDK / network involvement.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderEvent } from '../../provider.js';
import {
  createStreamState,
  translateChunk,
  usageFromState,
  finalizedToolCalls,
  isToolCallStop,
  type OpenAIChunk,
} from './translate.js';

const SESSION_ID = 'session-test';

function collect(chunks: OpenAIChunk[]) {
  const state = createStreamState();
  const events: ProviderEvent[] = [];
  for (const c of chunks) {
    for (const ev of translateChunk(c, state, SESSION_ID)) {
      events.push(ev);
    }
  }
  return { state, events };
}

describe('translateChunk — text streaming', () => {
  it('emits a delta.text per content chunk', () => {
    const { events, state } = collect([
      { choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { choices: [{ index: 0, delta: { content: ', ' } }] },
      { choices: [{ index: 0, delta: { content: 'world!' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(events).toEqual([
      { type: 'delta.text', text: 'Hello', sessionId: SESSION_ID },
      { type: 'delta.text', text: ', ', sessionId: SESSION_ID },
      { type: 'delta.text', text: 'world!', sessionId: SESSION_ID },
    ]);
    expect(state.assistantText).toBe('Hello, world!');
    expect(state.finishReason).toBe('stop');
  });

  it('skips empty / null content deltas', () => {
    const { events } = collect([
      { choices: [{ index: 0, delta: { content: '' } }] },
      { choices: [{ index: 0, delta: { content: null } }] },
      { choices: [{ index: 0, delta: { content: 'real' } }] },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'delta.text', text: 'real' });
  });

  it('captures usage from the final chunk', () => {
    const { state } = collect([
      { choices: [{ index: 0, delta: { content: 'hi' } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ]);
    const u = usageFromState(state);
    expect(u.inputTokens).toBe(10);
    expect(u.outputTokens).toBe(5);
    expect(u.cachedInputTokens).toBe(4);
    expect(u.totalTokens).toBe(15);
    expect(u.stopReason).toBe('stop');
    expect(u.isError).toBe(false);
  });

  it('synthesizes total_tokens when missing', () => {
    const { state } = collect([
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]);
    expect(usageFromState(state).totalTokens).toBe(10);
  });
});

describe('translateChunk — reasoning streaming', () => {
  it('emits delta.reasoning from reasoning_content field', () => {
    const { events, state } = collect([
      { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
      { choices: [{ delta: { reasoning_content: ' more' } }] },
      { choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] },
    ]);
    const reasoningEvents = events.filter((e) => e.type === 'delta.reasoning');
    expect(reasoningEvents).toHaveLength(2);
    expect(state.reasoningText).toBe('thinking... more');
  });

  it('accepts reasoning field as fallback name', () => {
    const { state } = collect([{ choices: [{ delta: { reasoning: 'inner monologue' } }] }]);
    expect(state.reasoningText).toBe('inner monologue');
  });
});

describe('translateChunk — tool calls', () => {
  it('accumulates a single tool call across chunks without emitting events', () => {
    // OpenAI streams: name arrives in pieces, arguments arrive in pieces.
    const { events, state } = collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_abc', type: 'function', function: { name: 'bash' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ls -la"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    // No events during accumulation — tool.use.start fires from the loop.
    expect(events).toHaveLength(0);
    const final = finalizedToolCalls(state);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      index: 0,
      id: 'call_abc',
      name: 'bash',
      argumentsRaw: '{"command":"ls -la"}',
    });
    expect(isToolCallStop(state)).toBe(true);
  });

  it('handles multiple parallel tool calls, returns them sorted by index', () => {
    const { state } = collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'call_b', function: { name: 'read_file' } },
                { index: 0, id: 'call_a', function: { name: 'bash' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"c":1}' } },
                { index: 1, function: { arguments: '{"p":"x"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const final = finalizedToolCalls(state);
    expect(final.map((c) => c.index)).toEqual([0, 1]);
    expect(final.map((c) => c.name)).toEqual(['bash', 'read_file']);
  });

  it('isToolCallStop is true when finish_reason missing but tool_calls present', () => {
    // Some OpenAI-compatible providers omit finish_reason in this case.
    const { state } = collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'bash' } }] } }] },
    ]);
    expect(isToolCallStop(state)).toBe(true);
  });

  it('isToolCallStop accepts legacy function_call finish_reason', () => {
    const { state } = collect([{ choices: [{ delta: {}, finish_reason: 'function_call' }] }]);
    expect(isToolCallStop(state)).toBe(true);
  });

  it('isToolCallStop is false for stop finish reason with no tool calls', () => {
    const { state } = collect([
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    expect(isToolCallStop(state)).toBe(false);
  });
});

describe('translateChunk — robustness', () => {
  it('survives chunks with no choices', () => {
    const { events, state } = collect([{ id: 'cmpl-1', model: 'gpt-4' }]);
    expect(events).toHaveLength(0);
    expect(state.id).toBe('cmpl-1');
    expect(state.model).toBe('gpt-4');
  });

  it('survives empty delta', () => {
    const { events } = collect([{ choices: [{ delta: {} }] }]);
    expect(events).toHaveLength(0);
  });

  it('does not overwrite captured id/model on later chunks', () => {
    const { state } = collect([
      { id: 'first', model: 'gpt-4' },
      { id: 'second', model: 'gpt-5' },
    ]);
    expect(state.id).toBe('first');
    expect(state.model).toBe('gpt-4');
  });
});
