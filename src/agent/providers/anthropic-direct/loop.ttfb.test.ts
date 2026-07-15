// Time-to-first-byte (TTFB) stall-timeout tests for loop.ts (issue #583).
//
// Pins the per-request first-byte bound: a call that streams NO first event
// within AFK_MODEL_TTFB_TIMEOUT_MS is aborted and retried once, then surfaces
// as an error — instead of hanging up to the SDK's ~10-min default. A stream
// that DOES yield a first byte within the bound is unaffected (even if it then
// runs long), and setting the bound to 0 disables the mechanism entirely.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { DEFAULT_MODEL_TTFB_TIMEOUT_MS } from '../shared/first-byte-timeout.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';

const KEY = 'AFK_MODEL_TTFB_TIMEOUT_MS';

// A stream that emits message_start, then STALLS before any content event
// until the request signal aborts — at which point it throws an AbortError,
// exactly like the SDK's stream iterator does. Models a post-headers stall.
function postHeaderStallStream(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      let sentStart = false;
      return {
        next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          if (!sentStart) {
            sentStart = true;
            return Promise.resolve({
              done: false,
              value: {
                type: 'message_start',
                message: {
                  id: 'msg_stall', type: 'message', role: 'assistant', content: [],
                  model: 'claude-test', stop_reason: null, stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                },
              } as unknown as RawMessageStreamEvent,
            });
          }
          // Second pull: never resolves until the (linked TTFB) signal aborts.
          return new Promise((_resolve, reject) => {
            if (signal.aborted) { reject(new Error('aborted')); return; }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      };
    },
  };
}

// A messages.create() promise that NEVER resolves until the request signal
// aborts, then rejects — models a connection-phase stall (no response headers).
function connectionStall(signal: AbortSignal): Promise<AsyncIterable<RawMessageStreamEvent>> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('runTurn TTFB stall timeout (#583)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('aborts a post-headers stall at the bound, retries once, then succeeds', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          // First call stalls after headers; retry streams a normal response.
          return callCount === 1
            ? postHeaderStallStream(signal)
            : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const resultPromise = collect(
      runTurn({
        client, messages, system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );

    // Advance PAST the 180s bound so the stall timer fires and the retry runs.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    const events = await resultPromise;

    expect(callCount).toBe(2); // original + one retry
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // Exactly one stream.retry marker so surfaces clear the stalled attempt.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
    // The recovered assistant text made it through.
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'recovered')).toBe(true);
  });

  it('aborts a connection-phase stall at the bound and retries once', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          return callCount === 1 ? connectionStall(signal) : fromArray(makeTextStream('ok'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('surfaces an error (not a hang) when the retry also stalls — one bound + one retry', async () => {
    process.env[KEY] = '180000';
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          return postHeaderStallStream(signal); // always stalls
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    // First bound → retry; retry bound → error. Advance past BOTH bounds.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    const events = await resultPromise;

    // Exactly 2 calls: original + one retry. No third attempt (no stacking).
    expect(callCount).toBe(2);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    // Exactly one retry marker was emitted before the error.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('does NOT abort a stream that yields a first byte within the bound, even if it then runs long', async () => {
    process.env[KEY] = '180000';
    // Stream that yields message_start + a content delta quickly, then a long
    // gap before the terminal events — the timer must already be cancelled by
    // the first event, so no abort/retry fires.
    function slowButProgressingStream(): AsyncIterable<RawMessageStreamEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
          const queue: RawMessageStreamEvent[] = makeTextStream('progressing');
          let i = 0;
          return {
            async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
              if (i >= queue.length) return { done: true, value: undefined };
              const value = queue[i]!;
              i++;
              // After the first content delta (index 2), insert a long delay to
              // prove the (now-cancelled) timer does not fire mid-stream.
              if (i === 3) await new Promise<void>((r) => { const t = setTimeout(r, 600_000); (t as { unref?: () => void }).unref?.(); });
              return { done: false, value };
            },
          };
        },
      };
    }
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => { callCount++; return slowButProgressingStream(); }) },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: new AbortController().signal, ctx,
      }),
    );
    // Advance well past the bound AND past the mid-stream 600s gap.
    await vi.advanceTimersByTimeAsync(700_000);
    const events = await resultPromise;

    expect(callCount).toBe(1); // no retry
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'progressing')).toBe(true);
  });

  it('AFK_MODEL_TTFB_TIMEOUT_MS=0 disables the timeout (no abort/retry on a stall)', async () => {
    process.env[KEY] = '0';
    let callCount = 0;
    let aborted = false;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          callCount++;
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => { aborted = true; });
          return postHeaderStallStream(signal);
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {},
        signal: abortController.signal, ctx,
      }),
    );
    // Advance far past what WOULD be the default bound — nothing should fire.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS * 4);
    // The stream is genuinely hung (disabled timeout = SDK-default behaviour),
    // so we abort from the caller side to let the generator settle for the test.
    expect(callCount).toBe(1);
    expect(aborted).toBe(false); // our TTFB timer never aborted the request
    abortController.abort('test cleanup');
    await vi.advanceTimersByTimeAsync(10);
    const events = await resultPromise;
    // Caller-abort yields a terminal turn.completed, and no retry ever happened.
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
  });
});
