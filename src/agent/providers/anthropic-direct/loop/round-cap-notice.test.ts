/**
 * Tests for round-cap delivery notice injection in the anthropic-direct loop.
 *
 * Verifies:
 *   1. The notice text reaches the user-array tail at the notice round.
 *   2. round_cap_notice_dropped trace event fires when the tail after dispatch
 *      is NOT a user message with array content (forced via mock).
 *   3. No notice and no drop event on non-notice rounds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock trace emitter BEFORE any imports that pull it in transitively.
vi.mock('../../../trace/emit.js', () => ({
  emitSessionPhase: vi.fn().mockResolvedValue(undefined),
  emitQueuedUserMessage: vi.fn().mockResolvedValue(undefined),
  emitToolCall: vi.fn().mockResolvedValue(undefined),
}));

// Mock dispatchToolCalls so we don't need a real Anthropic client.
vi.mock('./tool-dispatch.js', () => ({
  dispatchToolCalls: vi.fn(),
}));

// Mock emitAndCommitToolResults so we control the tail message shape.
vi.mock('./tool-results.js', () => ({
  emitAndCommitToolResults: vi.fn(),
}));

import { runToolRound } from './tool-round.js';
import { TurnAccumulator } from './turn-accumulator.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { dispatchToolCalls } from './tool-dispatch.js';
import { emitAndCommitToolResults } from './tool-results.js';
import type { RunTurnInput, TurnResult } from '../types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal messages ending in a user-array tool_result turn (normal shape). */
function makeArrayTailMessages(): MessageParam[] {
  return [
    { role: 'user', content: 'go' },
  ];
}

function makeTurnResult(): TurnResult {
  return {
    stopReason: 'tool_use',
    assistantBlocks: [
      { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
    ],
    toolUseBlocks: [
      { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
    ],
    text: '',
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as TurnResult;
}

function makeInput(messages: MessageParam[]): RunTurnInput {
  const controller = new AbortController();
  return {
    messages,
    system: null,
    tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object', properties: {}, required: [] } }],
    toolDispatcher: { dispatch: vi.fn().mockResolvedValue({ output: 'ok' }) },
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal: controller.signal,
    ctx: { sessionId: 'test-notice' },
    journalSync: undefined,
    traceWriter: undefined,
  } as unknown as RunTurnInput;
}

async function drainGen<T, R>(gen: AsyncGenerator<T, R, void>): Promise<{ yielded: T[]; returned: R }> {
  const yielded: T[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value as R };
    yielded.push(step.value);
  }
}

// ---------------------------------------------------------------------------
// Setup: dispatchToolCalls and emitAndCommitToolResults are mocked.
// We control what they push onto input.messages.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(emitSessionPhase).mockClear();

  // dispatchToolCalls: return a normal dispatched result (never aborted).
  vi.mocked(dispatchToolCalls).mockImplementation(async function* (
    _turnResult: unknown,
    _input: unknown,
    _turn: unknown,
  ) {
    return {
      kind: 'dispatched' as const,
      calls: [],
      results: [],
      startTimes: [],
    };
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('anthropic-direct round-cap notice injection', () => {
  it('appends notice text to the user-array tail at the notice round', async () => {
    // budget=5 → notice fires at round max(1,5-3)=2.
    // After dispatchToolCalls, emitAndCommitToolResults pushes a user-array
    // tool_result message. We simulate that here.
    const messages = makeArrayTailMessages();
    const input = makeInput(messages);

    vi.mocked(emitAndCommitToolResults).mockImplementation(async function* (
      _calls: unknown,
      _results: unknown,
      _starts: unknown,
      inp: RunTurnInput,
    ) {
      // Push the normal tool_result user message with array content.
      inp.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1\nfile2' }],
      });
      return 'committed' as const;
    } as never);

    const turn = new TurnAccumulator();
    turn.iterations = 1; // becomes 2 inside runToolRound (after turn.iterations += 1)

    await drainGen(runToolRound(makeTurnResult(), input, turn, 5, 0));

    // turn.iterations is now 2; notice round for budget=5 is 2.
    // The last message (user-array) should contain the notice text block.
    const lastMsg = messages[messages.length - 1] as MessageParam;
    expect(lastMsg.role).toBe('user');
    const content = lastMsg.content as Array<{ type: string; text?: string }>;
    const noticeBlock = content.find((b) => b.type === 'text' && b.text?.includes('Budget notice'));
    expect(noticeBlock).toBeDefined();
    expect(noticeBlock?.text).toContain('tool-use rounds remain');
  });

  it('does NOT inject notice on a non-notice round', async () => {
    // budget=50 → notice fires at round 47; round 3 should be null.
    const messages = makeArrayTailMessages();
    const input = makeInput(messages);

    vi.mocked(emitAndCommitToolResults).mockImplementation(async function* (
      _calls: unknown,
      _results: unknown,
      _starts: unknown,
      inp: RunTurnInput,
    ) {
      inp.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      });
      return 'committed' as const;
    } as never);

    const turn = new TurnAccumulator();
    turn.iterations = 2; // becomes 3

    await drainGen(runToolRound(makeTurnResult(), input, turn, 50, 0));

    const lastMsg = messages[messages.length - 1] as MessageParam;
    const content = Array.isArray(lastMsg.content)
      ? (lastMsg.content as Array<{ type: string; text?: string }>)
      : [];
    const noticeBlock = content.find((b) => b.text?.includes('Budget notice'));
    expect(noticeBlock).toBeUndefined();
    expect(emitSessionPhase).not.toHaveBeenCalled();
  });

  it('emits round_cap_notice_dropped when tail is string-content user (not array)', async () => {
    // budget=5 → notice fires at round 2.
    // emitAndCommitToolResults pushes a string-content user message (abnormal
    // but possible in edge cases) — injection cannot happen.
    const messages = makeArrayTailMessages();
    const input = makeInput(messages);

    vi.mocked(emitAndCommitToolResults).mockImplementation(async function* (
      _calls: unknown,
      _results: unknown,
      _starts: unknown,
      inp: RunTurnInput,
    ) {
      // Push a string-content user message instead of array content.
      inp.messages.push({ role: 'user', content: 'plain string result' });
      return 'committed' as const;
    } as never);

    const turn = new TurnAccumulator();
    turn.iterations = 1; // becomes 2

    await drainGen(runToolRound(makeTurnResult(), input, turn, 5, 0));

    // The tail is a string-content user message — injection not possible.
    // round_cap_notice_dropped must have been emitted.
    expect(emitSessionPhase).toHaveBeenCalledWith(
      undefined, // traceWriter is undefined in this test
      expect.objectContaining({
        phase: 'round_cap_notice_dropped',
        metadata: expect.objectContaining({ provider: 'anthropic-direct', round: 2 }),
      }),
    );
  });
});
