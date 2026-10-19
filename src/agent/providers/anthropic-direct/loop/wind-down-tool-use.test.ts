/**
 * Regression tests for #4072 and PR4094:
 *
 * #4072 — wind-down rounds on anthropic-direct keep the tools array
 * (cache-preserving) but NEVER dispatch a tool_use reply.
 *
 * PR4094 — Items 1 and 2:
 *   Item 1: the wind-down early exit MUST yield assistant.message (with
 *     finalText and sessionId) BEFORE turn.completed, matching the normal
 *     terminal event shape expected by all consumers.
 *   Item 2: thinking/redacted_thinking blocks that survive the tool_use filter
 *     must be retained in safeBlocks; if no text block survives alongside them,
 *     a synthetic text block carrying finalText is appended so the answer is
 *     always reachable as prose — the placeholder is never silently swallowed.
 *
 * When the model responds to a wind-down round with `stop_reason: 'tool_use'`
 * the turn must:
 *   1. NOT dispatch any tools.
 *   2. Yield assistant.message BEFORE turn.completed (PR4094 Item 1).
 *   3. End with a `turn.completed` event whose `stopReason` equals the
 *      wind-down reason (not 'tool_use').
 *   4. Leave history terminating in a safe assistant message (no orphan
 *      `tool_use` block without a matching `tool_result`).
 *   5. Use the round's own text as the final answer, or the placeholder when
 *      there is no text.
 *   6. Retain thinking/redacted_thinking blocks and append text if needed
 *      (PR4094 Item 2).
 */

import { describe, it, expect, vi } from 'vitest';
import { runToolRound } from './tool-round.js';
import { TurnAccumulator } from './turn-accumulator.js';
import { TOOL_USE_LOOP_CAPPED } from '../../shared/tool-loop-cap.js';
import { WIND_DOWN_NO_ANSWER_PLACEHOLDER } from '../../shared/tool-loop-cap.js';
import type { RunTurnInput, TurnResult } from '../types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(): MessageParam[] {
  return [
    { role: 'user', content: 'do some work' },
  ];
}

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    stopReason: 'tool_use',
    assistantBlocks: [
      { type: 'tool_use', id: 'toolu_wd_01', name: 'bash', input: { command: 'ls' } },
    ],
    toolUseBlocks: [
      { type: 'tool_use', id: 'toolu_wd_01', name: 'bash', input: { command: 'ls' } },
    ],
    text: '',
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  } as unknown as TurnResult;
}

function makeInput(messages: MessageParam[]): RunTurnInput {
  const controller = new AbortController();
  return {
    messages,
    system: null,
    tools: [{ name: 'bash', description: 'Run a command', input_schema: { type: 'object', properties: {}, required: [] } }],
    toolDispatcher: {} as RunTurnInput['toolDispatcher'],
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal: controller.signal,
    ctx: { sessionId: 'test-wind-down' },
    journalSync: undefined,
  } as unknown as RunTurnInput;
}

/** Drain an async generator, returning all yielded values and the return value. */
async function drainGen<T, R>(gen: AsyncGenerator<T, R, void>): Promise<{ yielded: T[]; returned: R }> {
  const yielded: T[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value as R };
    yielded.push(step.value);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runToolRound — wind-down tool_use settlement (#4072)', () => {
  it('returns "terminated" without dispatching when windDownReason is set and model emits tool_use', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);
    // Spy on the toolDispatcher to confirm dispatch is never called.
    const dispatchSpy = vi.fn();
    (input as unknown as Record<string, unknown>)['toolDispatcher'] = { dispatch: dispatchSpy };

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    // Simulate: assistant message already pushed by the caller before runToolRound
    // (the function does this itself at line 66).
    const result = makeTurnResult();

    const { yielded, returned } = await drainGen(
      runToolRound(result, input, turn, 3, 0),
    );

    // Must terminate, not continue.
    expect(returned).toBe('terminated');

    // Must have emitted a turn.completed event.
    const completedEvents = yielded.filter((e) => (e as Record<string, unknown>)['type'] === 'turn.completed');
    expect(completedEvents).toHaveLength(1);

    // stopReason on the completed event must be the wind-down reason, not 'tool_use'.
    const completed = completedEvents[0] as Record<string, unknown>;
    const usage = completed['usage'] as Record<string, unknown>;
    expect(usage['stopReason']).toBe(TOOL_USE_LOOP_CAPPED);
    expect(usage['stopReason']).not.toBe('tool_use');
  });

  it('leaves history without an orphan tool_use block after wind-down tool_use settlement', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    const result = makeTurnResult(); // tool_use only, no text

    await drainGen(runToolRound(result, input, turn, 3, 0));

    // The last message in history must NOT be a bare tool_use block.
    const last = input.messages[input.messages.length - 1];
    expect(last).toBeDefined();
    // It must be the assistant turn — check it has no tool_use content.
    if (last!.role === 'assistant') {
      const content = Array.isArray(last!.content) ? last!.content : [{ type: 'text', text: last!.content }];
      const hasToolUse = content.some((b) => (b as Record<string, unknown>)['type'] === 'tool_use');
      expect(hasToolUse).toBe(false);
    }
    // History must not end in a user turn (which would mean a tool_result was committed).
    expect(last!.role).not.toBe('user');
  });

  it('uses WIND_DOWN_NO_ANSWER_PLACEHOLDER when the wind-down round has no text', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    // No text in the result — tool_use only.
    const result = makeTurnResult({ text: '' });

    await drainGen(runToolRound(result, input, turn, 3, 0));

    const last = input.messages[input.messages.length - 1];
    // When no text and safeBlocks is empty, assistant content is the placeholder.
    const content = typeof last!.content === 'string' ? last!.content : undefined;
    if (content !== undefined) {
      expect(content).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
    } else {
      // If content is an array, it must be non-empty and contain no tool_use.
      const arr = last!.content as unknown as Array<Record<string, unknown>>;
      expect(arr.every((b) => b['type'] !== 'tool_use')).toBe(true);
    }
  });

  it('uses the round text as the final answer when wind-down round returns text AND tool_use', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    // Round has both text and tool_use blocks.
    const result = makeTurnResult({
      text: 'Here is my summary.',
      assistantBlocks: [
        { type: 'text', text: 'Here is my summary.' } as unknown as TurnResult['assistantBlocks'][0],
        { type: 'tool_use', id: 'toolu_wd_02', name: 'bash', input: {} } as unknown as TurnResult['assistantBlocks'][0],
      ],
      toolUseBlocks: [
        { type: 'tool_use', id: 'toolu_wd_02', name: 'bash', input: {} } as unknown as TurnResult['toolUseBlocks'][0],
      ],
    });

    await drainGen(runToolRound(result, input, turn, 3, 0));

    const last = input.messages[input.messages.length - 1];
    expect(last!.role).toBe('assistant');
    // Content must contain the text block and NOT the tool_use block.
    const arr = Array.isArray(last!.content) ? (last!.content as unknown as Array<Record<string, unknown>>) : [];
    const textBlocks = arr.filter((b) => b['type'] === 'text');
    const toolBlocks = arr.filter((b) => b['type'] === 'tool_use');
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    expect(toolBlocks).toHaveLength(0);
  });

  it('does NOT dispatch tools on a wind-down round that returns tool_use', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);
    let dispatchCalled = false;

    // Patch toolDispatcher to detect any dispatch attempt.
    Object.defineProperty(input, 'toolDispatcher', {
      get: () => ({
        dispatch: () => { dispatchCalled = true; return Promise.resolve({ output: 'never' }); },
      }),
    });

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    await drainGen(runToolRound(makeTurnResult(), input, turn, 3, 0));

    expect(dispatchCalled).toBe(false);
  });

  // PR4094 Item 1 — assistant.message must precede turn.completed
  it('emits assistant.message BEFORE turn.completed on wind-down tool_use settlement (PR4094 Item 1)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    const result = makeTurnResult({ text: 'Summary of findings.' });

    const { yielded } = await drainGen(runToolRound(result, input, turn, 3, 0));

    const types = yielded.map((e) => (e as Record<string, unknown>)['type']);
    const msgIdx = types.indexOf('assistant.message');
    const cmpIdx = types.indexOf('turn.completed');

    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(cmpIdx).toBeGreaterThanOrEqual(0);
    expect(msgIdx).toBeLessThan(cmpIdx);
  });

  it('assistant.message carries finalText and sessionId on wind-down settlement (PR4094 Item 1)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    const result = makeTurnResult({ text: 'My final answer.' });

    const { yielded } = await drainGen(runToolRound(result, input, turn, 3, 0));

    const msgEvent = yielded.find(
      (e) => (e as Record<string, unknown>)['type'] === 'assistant.message',
    ) as Record<string, unknown> | undefined;

    expect(msgEvent).toBeDefined();
    expect(msgEvent!['text']).toBe('My final answer.');
    expect(msgEvent!['sessionId']).toBe('test-wind-down');
  });

  it('assistant.message uses placeholder when wind-down round has no text (PR4094 Item 1)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    const result = makeTurnResult({ text: '' }); // tool_use only, no text

    const { yielded } = await drainGen(runToolRound(result, input, turn, 3, 0));

    const msgEvent = yielded.find(
      (e) => (e as Record<string, unknown>)['type'] === 'assistant.message',
    ) as Record<string, unknown> | undefined;

    expect(msgEvent).toBeDefined();
    expect(msgEvent!['text']).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
  });

  // PR4094 Item 2 — thinking/redacted_thinking blocks retained; text appended when needed
  it('retains thinking blocks and appends text block when wind-down has thinking+tool_use only (PR4094 Item 2)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    // Model emits thinking + tool_use, no text block.
    const result = makeTurnResult({
      text: '',
      assistantBlocks: [
        { type: 'thinking', thinking: 'I should look this up.', signature: 'sig' } as unknown as TurnResult['assistantBlocks'][0],
        { type: 'tool_use', id: 'toolu_wd_03', name: 'bash', input: {} } as unknown as TurnResult['assistantBlocks'][0],
      ],
      toolUseBlocks: [
        { type: 'tool_use', id: 'toolu_wd_03', name: 'bash', input: {} } as unknown as TurnResult['toolUseBlocks'][0],
      ],
    });

    await drainGen(runToolRound(result, input, turn, 3, 0));

    const last = input.messages[input.messages.length - 1];
    expect(last!.role).toBe('assistant');
    const arr = Array.isArray(last!.content)
      ? (last!.content as unknown as Array<Record<string, unknown>>)
      : [];

    // thinking block must be retained
    expect(arr.some((b) => b['type'] === 'thinking')).toBe(true);
    // tool_use must be stripped
    expect(arr.some((b) => b['type'] === 'tool_use')).toBe(false);
    // a text block must have been appended with the placeholder
    const textBlocks = arr.filter((b) => b['type'] === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!['text']).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
  });

  it('retains redacted_thinking blocks and appends text block when wind-down has no prose (PR4094 Item 2)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    const result = makeTurnResult({
      text: '',
      assistantBlocks: [
        { type: 'redacted_thinking', data: 'opaque' } as unknown as TurnResult['assistantBlocks'][0],
        { type: 'tool_use', id: 'toolu_wd_04', name: 'bash', input: {} } as unknown as TurnResult['assistantBlocks'][0],
      ],
      toolUseBlocks: [
        { type: 'tool_use', id: 'toolu_wd_04', name: 'bash', input: {} } as unknown as TurnResult['toolUseBlocks'][0],
      ],
    });

    await drainGen(runToolRound(result, input, turn, 3, 0));

    const last = input.messages[input.messages.length - 1];
    const arr = Array.isArray(last!.content)
      ? (last!.content as unknown as Array<Record<string, unknown>>)
      : [];

    expect(arr.some((b) => b['type'] === 'redacted_thinking')).toBe(true);
    expect(arr.some((b) => b['type'] === 'tool_use')).toBe(false);
    const textBlocks = arr.filter((b) => b['type'] === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!['text']).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
  });

  it('does NOT append a duplicate text block when wind-down has thinking + text + tool_use (PR4094 Item 2)', async () => {
    const messages = makeMessages();
    const input = makeInput(messages);

    const turn = new TurnAccumulator();
    turn.windDownReason = TOOL_USE_LOOP_CAPPED;

    // Model emits thinking + real text + tool_use — text must NOT be duplicated.
    const result = makeTurnResult({
      text: 'Safe prose answer.',
      assistantBlocks: [
        { type: 'thinking', thinking: 'Reasoning...', signature: 'sig2' } as unknown as TurnResult['assistantBlocks'][0],
        { type: 'text', text: 'Safe prose answer.' } as unknown as TurnResult['assistantBlocks'][0],
        { type: 'tool_use', id: 'toolu_wd_05', name: 'bash', input: {} } as unknown as TurnResult['assistantBlocks'][0],
      ],
      toolUseBlocks: [
        { type: 'tool_use', id: 'toolu_wd_05', name: 'bash', input: {} } as unknown as TurnResult['toolUseBlocks'][0],
      ],
    });

    await drainGen(runToolRound(result, input, turn, 3, 0));

    const last = input.messages[input.messages.length - 1];
    const arr = Array.isArray(last!.content)
      ? (last!.content as unknown as Array<Record<string, unknown>>)
      : [];

    // Exactly one text block — the real one, not a synthetic duplicate.
    const textBlocks = arr.filter((b) => b['type'] === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!['text']).toBe('Safe prose answer.');
    expect(arr.some((b) => b['type'] === 'thinking')).toBe(true);
    expect(arr.some((b) => b['type'] === 'tool_use')).toBe(false);
  });
});
