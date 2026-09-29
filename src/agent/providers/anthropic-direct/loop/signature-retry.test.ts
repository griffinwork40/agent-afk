/**
 * Unit tests for the invalid-signature retry helpers.
 *
 * Covers:
 *  - isInvalidSignatureError: positive/negative classification
 *  - stripEarlierThinking: boundary semantics
 *  - buildSignatureRetryMessages: integrated boundary + early-exit
 *  - Wiring: a 400 invalid-signature triggers exactly one retry with stripped
 *    messages; a second identical failure surfaces the original error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import {
  isInvalidSignatureError,
  stripEarlierThinking,
  buildSignatureRetryMessages,
} from './signature-retry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeErr(msg: string, status?: number): Error {
  const e = new Error(msg);
  if (status !== undefined) (e as unknown as Record<string, unknown>)['status'] = status;
  return e;
}

// ---------------------------------------------------------------------------
// isInvalidSignatureError
// ---------------------------------------------------------------------------

describe('isInvalidSignatureError', () => {
  it('matches a 400 with signature + thinking in message', () => {
    const e = makeErr('Invalid `signature` in `thinking` block', 400);
    expect(isInvalidSignatureError(e)).toBe(true);
  });

  it('matches when status is detected from the message text (no .status field)', () => {
    const e = new Error('400 Bad Request: invalid signature in thinking block');
    expect(isInvalidSignatureError(e)).toBe(true);
  });

  it('does NOT match a 400 that has nothing to do with thinking', () => {
    const e = makeErr('Invalid tool schema: extra field not permitted', 400);
    expect(isInvalidSignatureError(e)).toBe(false);
  });

  it('does NOT match a 401 error that happens to mention signature', () => {
    const e = makeErr('401 Unauthorized — invalid signature in auth header', 401);
    expect(isInvalidSignatureError(e)).toBe(false);
  });

  it('does NOT match a message mentioning thinking but not signature', () => {
    const e = makeErr('400 thinking block must have at least one text block', 400);
    expect(isInvalidSignatureError(e)).toBe(false);
  });

  it('does NOT match a 400 mentioning only "signature" without "thinking"', () => {
    // Regression guard: an auth or crypto 400 that mentions "signature" but
    // has nothing to do with thinking blocks must not trigger the retry.
    const e = makeErr('400 Bad Request: invalid request signature', 400);
    expect(isInvalidSignatureError(e)).toBe(false);
  });

  it('does NOT match a non-Error value', () => {
    expect(isInvalidSignatureError('string error')).toBe(false);
    expect(isInvalidSignatureError(null)).toBe(false);
    expect(isInvalidSignatureError(42)).toBe(false);
  });

  it('is case-insensitive for the word thinking', () => {
    const e = makeErr('400 Invalid signature in THINKING block', 400);
    expect(isInvalidSignatureError(e)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripEarlierThinking
// ---------------------------------------------------------------------------

describe('stripEarlierThinking', () => {
  it('removes thinking blocks from assistant messages before lastRealUserIdx', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig1' } as never,
          { type: 'text', text: 'reply' },
        ],
      },
      { role: 'user', content: 'turn 2' },            // lastRealUserIdx = 2
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'in-flight', signature: 'sig2' } as never,
          { type: 'text', text: 'ongoing' },
        ],
      },
    ];

    const result = stripEarlierThinking(messages, 2);

    // Index 1: thinking stripped, text block kept
    const assistantEarlier = result[1]!;
    expect(assistantEarlier.role).toBe('assistant');
    const earlierBlocks = assistantEarlier.content as Array<{ type: string }>;
    expect(earlierBlocks.every((b) => b.type !== 'thinking')).toBe(true);
    expect(earlierBlocks.some((b) => b.type === 'text')).toBe(true);

    // Index 3 (>= lastRealUserIdx=2): in-flight thinking preserved
    const assistantInFlight = result[3]!;
    expect(assistantInFlight.role).toBe('assistant');
    const inFlightBlocks = assistantInFlight.content as Array<{ type: string }>;
    expect(inFlightBlocks.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('strips redacted_thinking blocks from earlier turns', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'blob' } as never,
          { type: 'text', text: 'ok' },
        ],
      },
      { role: 'user', content: 'follow-up' },         // lastRealUserIdx = 2
    ];

    const result = stripEarlierThinking(messages, 2);
    const blocks = result[1]!.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'redacted_thinking')).toBe(false);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('replaces a thinking-only assistant message with a placeholder text block', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'only thinking', signature: 'sig' } as never],
      },
      { role: 'user', content: 'follow-up' },         // lastRealUserIdx = 2
    ];

    const result = stripEarlierThinking(messages, 2);
    const blocks = result[1]!.content as Array<{ type: string; text?: string }>;
    // Must not be empty (API rejects empty content arrays)
    expect(blocks.length).toBeGreaterThan(0);
    // Must be a text block
    expect(blocks[0]?.type).toBe('text');
    expect(typeof blocks[0]?.text).toBe('string');
    expect(blocks[0]!.text!.length).toBeGreaterThan(0);
  });

  it('leaves user messages and string-content assistant messages untouched', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'plain user' },
      { role: 'assistant', content: 'plain assistant' },
      { role: 'user', content: 'follow-up' },         // lastRealUserIdx = 2
    ];
    const result = stripEarlierThinking(messages, 2);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);   // unchanged reference
  });

  it('returns a new array (pure — does not mutate the input)', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 's' } as never,
          { type: 'text', text: 'a' },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    const original = JSON.stringify(messages);
    stripEarlierThinking(messages, 2);
    expect(JSON.stringify(messages)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// buildSignatureRetryMessages
// ---------------------------------------------------------------------------

describe('buildSignatureRetryMessages', () => {
  it('returns null when there is no earlier-turn thinking to strip', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'only turn' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result' as never, tool_use_id: 'x', content: [] }],
      },
    ];
    expect(buildSignatureRetryMessages(messages)).toBeNull();
  });

  it('returns null when there are no messages before the last real user turn', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'only user message' }];
    expect(buildSignatureRetryMessages(messages)).toBeNull();
  });

  it('strips earlier thinking and returns a new array when earlier thinking exists', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 's' } as never,
          { type: 'text', text: 'a' },
        ],
      },
      { role: 'user', content: 'turn 2' },   // last real user
    ];
    const result = buildSignatureRetryMessages(messages);
    expect(result).not.toBeNull();
    const blocks = result![1]!.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
  });

  it('treats a purely-tool_result user message as in-flight (not a real user turn)', () => {
    // last REAL user is index 0; the tool_result at index 2 is in-flight
    const messages: MessageParam[] = [
      { role: 'user', content: 'real turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 's' } as never,
          { type: 'tool_use', id: 'id1', name: 'bash', input: {} } as never,
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result' as never, tool_use_id: 'id1', content: 'ok' }],
      },
    ];
    const result = buildSignatureRetryMessages(messages);
    // lastRealUserIdx = 0, so messages[1] (assistant) is index >= 0; BUT
    // stripEarlierThinking only strips indices i < lastRealUserIdx=0 → nothing
    // Actually: index 0 is real user, index 1 is assistant (before? no, >= 0).
    // Wait — assistant is at index 1 which is >= lastRealUserIdx(0); it's kept.
    // So nothing to strip in this config — result should be null.
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring: one-shot retry inside openRound
// ---------------------------------------------------------------------------

describe('openRound signature-retry wiring', () => {
  // We test the wiring by directly calling openRound with a mock client that
  // raises a 400 invalid-signature error on the first call and succeeds on the
  // second (or fails again). We build a minimal RunTurnInput and TurnAccumulator.

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  /** Build a minimal but type-complete RunTurnInput for wiring tests. */
  function makeInput(
    client: { messages: { create: () => unknown } },
    messages: MessageParam[],
  ) {
    const abortCtrl = new AbortController();
    return {
      client,
      messages,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024,
      system: null,
      tools: null,
      thinking: undefined,
      effort: undefined,
      temperature: undefined,
      fastMode: undefined,
      headers: {} as Record<string, string>,
      signal: abortCtrl.signal,
      baseUrl: undefined,
      traceWriter: null,
      ctx: { sessionId: 'test-session' },
      journalSync: undefined,
    } as never; // cast: we only need the fields openRound actually reads
  }

  /** Minimal TurnAccumulator for the wiring tests. */
  function makeTurn() {
    return {
      windDownReason: null,
      terminalUsage: () => ({ stopReason: 'end_turn' as const }),
    } as never;
  }

  /** Minimal RoundRetryBudget. */
  function makeRetry() {
    return {
      canRetryTtfb: () => false,
      ttfbRetries: 0,
      overloadRetries: 0,
      streamIncompleteRetries: 0,
      reset: () => undefined,
    } as never;
  }

  async function collectResults(gen: AsyncGenerator<unknown, unknown, void>) {
    const events: unknown[] = [];
    let result: IteratorResult<unknown, unknown>;
    do {
      result = await gen.next();
      if (!result.done) events.push(result.value);
    } while (!result.done);
    return { events, returnValue: result.value };
  }

  it('retries with stripped messages when the first call raises 400 invalid signature, and succeeds on second call', async () => {
    // Earlier-turn assistant thinking + a subsequent real user message
    const messages: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 's' } as never,
          { type: 'text', text: 'answer' },
        ],
      },
      { role: 'user', content: 'turn 2' },    // last real user
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'in-flight', signature: 'sig2' } as never,
          { type: 'tool_use', id: 'id1', name: 'bash', input: {} } as never,
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result' as never, tool_use_id: 'id1', content: 'ok' }],
      },
    ];

    let callCount = 0;
    // Fake async iterable that immediately returns nothing (simulating a live stream)
    const fakeStream = (async function* () {})();
    const client = {
      messages: {
        create: () => {
          callCount += 1;
          if (callCount === 1) {
            const e = new Error('400 Invalid `signature` in `thinking` block');
            (e as unknown as Record<string, unknown>)['status'] = 400;
            throw e;
          }
          return Promise.resolve(fakeStream);
        },
      },
    };

    const { openRound } = await import('./round-request.js');
    const input = makeInput(client, messages);
    const gen = openRound({
      input,
      turn: makeTurn(),
      retry: makeRetry(),
      ttfbTimeoutMs: 30_000,
      stallTimeoutMs: 120_000,
    });

    const { returnValue } = await collectResults(gen);

    expect(callCount).toBe(2);
    expect((returnValue as { kind: string }).kind).toBe('opened');

    // Earlier-turn thinking should be stripped from the working messages
    const assistantEarlier = input.messages[1]!;
    const blocks = assistantEarlier.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);

    // In-flight thinking (index 3) should be preserved
    const assistantInFlight = input.messages[3]!;
    const inFlightBlocks = assistantInFlight.content as Array<{ type: string }>;
    expect(inFlightBlocks.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('surfaces the original error when the retry also fails with 400 invalid signature', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 's' } as never,
          { type: 'text', text: 'a' },
        ],
      },
      { role: 'user', content: 'turn 2' },
    ];

    let callCount = 0;
    const client = {
      messages: {
        create: () => {
          callCount += 1;
          const e = new Error('400 Invalid `signature` in `thinking` block');
          (e as unknown as Record<string, unknown>)['status'] = 400;
          throw e;
        },
      },
    };

    const { openRound } = await import('./round-request.js');
    const input = makeInput(client, messages);
    const gen = openRound({
      input,
      turn: makeTurn(),
      retry: makeRetry(),
      ttfbTimeoutMs: 30_000,
      stallTimeoutMs: 120_000,
    });

    const { events, returnValue } = await collectResults(gen);

    expect(callCount).toBe(2);
    expect((returnValue as { kind: string }).kind).toBe('terminated');
    const errEvent = events.find((ev) => (ev as { type: string }).type === 'error');
    expect(errEvent).toBeDefined();
    expect((errEvent as { error: Error }).error.message).toContain('signature');
  });

  it('does NOT retry when the 400 has nothing to do with thinking signatures', async () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'only turn' }];
    let callCount = 0;
    const client = {
      messages: {
        create: () => {
          callCount += 1;
          const e = new Error('400 Bad Request: unknown field in tool schema');
          (e as unknown as Record<string, unknown>)['status'] = 400;
          throw e;
        },
      },
    };

    const { openRound } = await import('./round-request.js');
    const input = makeInput(client, messages);
    const gen = openRound({
      input,
      turn: makeTurn(),
      retry: makeRetry(),
      ttfbTimeoutMs: 30_000,
      stallTimeoutMs: 120_000,
    });

    const { returnValue } = await collectResults(gen);

    expect(callCount).toBe(1);
    expect((returnValue as { kind: string }).kind).toBe('terminated');
  });
});
