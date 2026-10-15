import { describe, it, expect } from 'vitest';
import { createStreamState, usageFromState, finalizedToolCalls, isToolCallStop } from './translate.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';
import { isOpenAIOverloadError } from './query/retry.js';
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

  // Regression: session ef121fd7 (gpt-6-astra via chatgpt-oauth) — the Codex
  // backend sent parallel function calls with NO argument deltas, only the
  // complete arguments on the *.done events. Ignoring them dispatched every
  // call with `{}` ("file_path must be a string").
  it('recovers parallel-call arguments delivered only on output_item.done', () => {
    const { state } = collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'read_file', arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'glob', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'read_file', arguments: '{"file_path":"/a"}' } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'glob', arguments: '{"pattern":"*.py"}' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    expect(finalizedToolCalls(state).map((c) => [c.id, c.name, c.argumentsRaw])).toEqual([
      ['c0', 'read_file', '{"file_path":"/a"}'],
      ['c1', 'glob', '{"pattern":"*.py"}'],
    ]);
    expect(isToolCallStop(state)).toBe(true);
  });

  it('recovers arguments delivered only on function_call_arguments.done', () => {
    const { state } = collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'bash', arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"command":"pwd"}' },
    ]);
    expect(finalizedToolCalls(state)[0]).toMatchObject({ id: 'c0', name: 'bash', argumentsRaw: '{"command":"pwd"}' });
  });

  it('seeds the tool name from function_call_arguments.done when no item event arrived', () => {
    const { state } = collect([
      { type: 'response.function_call_arguments.done', output_index: 0, name: 'bash', arguments: '{"command":"ls"}' },
    ]);
    expect(finalizedToolCalls(state)[0]).toMatchObject({ name: 'bash', argumentsRaw: '{"command":"ls"}' });
  });

  it('does not double-count when deltas AND done both arrive; empty done keeps deltas', () => {
    const { state } = collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'fn', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"x":1}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c0', name: 'fn', arguments: '' } },
    ]);
    expect(finalizedToolCalls(state)[0]).toMatchObject({ argumentsRaw: '{"x":1}' });
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

// ---------------------------------------------------------------------------
// #2843 — overload shapes that bypass inline retry/pause
// ---------------------------------------------------------------------------

describe('translateResponsesEvent — overload bypass shapes (#2843)', () => {
  /**
   * Helper: run translateResponsesEvent for a single event and return either
   * the thrown error or the list of emitted ProviderEvents.
   */
  function runEvent(event: { type: string; [k: string]: unknown }):
    | { threw: Error; events: undefined }
    | { threw: undefined; events: ProviderEvent[] } {
    const state = createStreamState();
    const out: ProviderEvent[] = [];
    try {
      for (const ev of translateResponsesEvent(
        event as import('./responses-translate.js').ResponsesStreamEvent,
        state,
        SESSION_ID,
      )) {
        out.push(ev);
      }
      return { threw: undefined, events: out };
    } catch (e) {
      return { threw: e as Error, events: undefined };
    }
  }

  // ── Shape 1: top-level { type:'error', code:'server_is_overloaded', message }
  it('shape 1: throws for overload code so isOpenAIOverloadError matches', () => {
    const { threw } = runEvent({
      type: 'error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded',
    });
    expect(threw).toBeDefined();
    // The thrown error must have no status (so isOpenAIOverloadError passes the
    // getErrorStatus guard) and carry code:'server_is_overloaded'.
    const err = threw as Error & { code?: string; status?: number };
    expect(err.status).toBeUndefined();
    expect(err.code).toBe('server_is_overloaded');
    expect(err.message).toBe('Our servers are currently overloaded');
    // Confirm the thrown error is recognised by isOpenAIOverloadError.
    expect(isOpenAIOverloadError(threw)).toBe(true);
  });

  it('shape 1: also throws for a non-overload error code (surfaces as fatal stream error)', () => {
    const { threw } = runEvent({
      type: 'error',
      code: 'invalid_prompt',
      message: 'Prompt contained disallowed content',
    });
    expect(threw).toBeDefined();
    expect(threw!.message).toBe('Prompt contained disallowed content');
    // Non-overload code must NOT be flagged as an overload.
    expect(isOpenAIOverloadError(threw)).toBe(false);
  });

  it('shape 1: throws with a fallback message when event.message is absent', () => {
    const { threw } = runEvent({ type: 'error', code: 'server_is_overloaded' });
    expect(threw).toBeDefined();
    expect(threw!.message).toContain('server_is_overloaded');
  });

  // ── Shape 2: response.failed carrying an overload-indicating error
  it('shape 2: throws for response.failed + overload message so isOpenAIOverloadError matches', () => {
    const { threw, events } = runEvent({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'server_error', message: 'Our servers are currently overloaded with requests' },
      },
    });
    expect(threw).toBeDefined();
    expect(events).toBeUndefined();
    // Must carry the server's error body so isOpenAIOverloadError can inspect it.
    const err = threw as Error & { error?: { code?: string; message?: string } };
    expect(err.error?.message).toContain('overloaded');
    expect(isOpenAIOverloadError(threw)).toBe(true);
  });

  it('shape 2: does NOT throw for response.failed with a non-overload error — finishReason stays "failed"', () => {
    const state = createStreamState();
    const gen = translateResponsesEvent(
      {
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'invalid_prompt', message: 'Prompt was invalid' } },
      },
      state,
      SESSION_ID,
    );
    // Must not throw; finishReason must remain 'failed'.
    expect(() => { for (const _ of gen) { /* drain */ } }).not.toThrow();
    expect(state.finishReason).toBe('failed');
  });

  it('shape 2: does NOT throw for response.failed with no error body — non-overload path unchanged', () => {
    const state = createStreamState();
    const gen = translateResponsesEvent(
      { type: 'response.failed', response: { status: 'failed' } },
      state,
      SESSION_ID,
    );
    expect(() => { for (const _ of gen) { /* drain */ } }).not.toThrow();
    expect(state.finishReason).toBe('failed');
  });
});
