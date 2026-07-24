// Transient-error / overload retry tests for loop.ts: isTransientServerError,
// isOverloadedErrorEvent, createWithRetry (via runTurn), and the mid-stream
// overload retry path. Split out of loop.test.ts (#370) — bodies moved verbatim.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import {
  runTurn,
  isTransientServerError,
  isOverloadedErrorEvent,
  OVERLOAD_MAX_RETRIES,
  STREAM_INCOMPLETE_MAX_RETRIES,
} from './loop.js';
import type { AnthropicClientLike } from './types.js';
import {
  fromArray,
  collect,
  ctx,
  baseUsage,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';


describe('isTransientServerError', () => {
  it('returns true for HTTP 529 (overloaded)', () => {
    const err = Object.assign(new Error('Overloaded'), { status: 529 });
    expect(isTransientServerError(err)).toBe(true);
  });

  it('returns true for HTTP 503 (service unavailable)', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(isTransientServerError(err)).toBe(true);
  });

  it('returns false for HTTP 429 (rate limit)', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    expect(isTransientServerError(err)).toBe(false);
  });

  it('returns false for HTTP 401 (auth)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isTransientServerError(err)).toBe(false);
  });

  it('returns false for errors without status', () => {
    expect(isTransientServerError(new Error('network failure'))).toBe(false);
  });
});

// ─── isOverloadedErrorEvent ──────────────────────────────────────────────────
//
// Mid-stream overloads carry NO HTTP status (the SDK throws them from inside
// the stream iterator as `new APIError(undefined, <parsed SSE body>, …)`), so
// detection must key off the parsed body, not `status`. The body shape from a
// real Anthropic `event: error` SSE frame is double-nested:
//   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
describe('isOverloadedErrorEvent', () => {
  it('detects a mid-stream overload from the double-nested SSE body (status undefined)', () => {
    const err = Object.assign(new Error('Overloaded'), {
      status: undefined,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_x' },
    });
    expect(isOverloadedErrorEvent(err)).toBe(true);
  });

  it('detects a flat overload body shape', () => {
    const err = Object.assign(new Error('Overloaded'), {
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(isOverloadedErrorEvent(err)).toBe(true);
  });

  it('detects a connection-phase 529/503 by status', () => {
    expect(isOverloadedErrorEvent(Object.assign(new Error('x'), { status: 529 }))).toBe(true);
    expect(isOverloadedErrorEvent(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
  });

  it('returns false for a non-overload error event (e.g. invalid_request)', () => {
    const err = Object.assign(new Error('bad'), {
      status: undefined,
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    });
    expect(isOverloadedErrorEvent(err)).toBe(false);
  });

  it('returns false for a plain error with no body or status', () => {
    expect(isOverloadedErrorEvent(new Error('network failure'))).toBe(false);
    expect(isOverloadedErrorEvent(null)).toBe(false);
    expect(isOverloadedErrorEvent(undefined)).toBe(false);
    expect(isOverloadedErrorEvent('overloaded_error')).toBe(false);
  });
});

// ─── createWithRetry (via runTurn) ───────────────────────────────────────────

describe('runTurn transient error retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 529 and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            throw Object.assign(new Error('Overloaded'), { status: 529, type: 'overloaded_error' });
          }
          return fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(10_000);

    const events = await resultPromise;

    expect(callCount).toBe(2);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
  });

  it('exhausts retries and yields error on persistent 529', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          throw Object.assign(new Error('Overloaded'), { status: 529, type: 'overloaded_error' });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Advance past all retry delays (5s + 10s + 20s = 35s)
    await vi.advanceTimersByTimeAsync(40_000);

    const events = await resultPromise;

    // 1 initial + OVERLOAD_MAX_RETRIES retries
    expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('Overloaded');
    }
  });

  it('does not retry non-transient errors (e.g. 400)', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          throw Object.assign(new Error('Bad request'), { status: 400 });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('aborts during retry sleep and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          throw Object.assign(new Error('Overloaded'), { status: 529 });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Let the first attempt fail, then abort during the sleep
    await vi.advanceTimersByTimeAsync(100);
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);

    const events = await resultPromise;

    expect(callCount).toBe(1);
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
  });
});

// ─── Mid-stream overload retry (via runTurn) ─────────────────────────────────
//
// Regression for the v3.78.x crash: an Anthropic `overloaded_error` delivered
// mid-stream (HTTP 200, then an `event: error` SSE frame) is thrown from the
// SDK stream iterator with `status === undefined`. createWithRetry — status-
// based and wrapping only the connection-phase messages.create() — never saw
// it, the auth/usage-limit retry tiers ignored it, and the error event
// propagated to a fatal turn crash. These tests pin the mid-stream retry path.
describe('runTurn mid-stream overload retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A stream that yields message_start then throws the exact mid-stream
  // overload shape the SDK produces: status undefined, double-nested
  // overloaded_error body. translateMessageStream catches the throw and yields
  // it as an in-band error event — the path runTurn must now retry.
  function midStreamOverloadStream(): AsyncIterable<RawMessageStreamEvent> {
    return (async function* () {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_overload', type: 'message', role: 'assistant', content: [],
          model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
        },
      } as unknown as RawMessageStreamEvent;
      throw Object.assign(new Error('Overloaded'), {
        status: undefined,
        error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_overload' },
      });
    })();
  }

  it('retries a mid-stream overload and succeeds on the next attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return callCount === 1 ? midStreamOverloadStream() : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000); // past the first 5s backoff
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // The retry emits exactly one stream.retry marker so surfaces can discard
    // the overloaded attempt's partial text before the recovered re-stream.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('exhausts the retry budget on a persistent mid-stream overload and yields the error', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => midStreamOverloadStream()) },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(40_000); // past all backoffs (5s + 10s + 20s)
    const events = await resultPromise;

    expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    // One stream.retry per backoff/re-drive — OVERLOAD_MAX_RETRIES total (the
    // final, exhausted attempt yields the error, not another retry marker).
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(OVERLOAD_MAX_RETRIES);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('Overloaded');
    }
  });

  it('does NOT retry a non-overload mid-stream error', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                id: 'msg_bad', type: 'message', role: 'assistant', content: [],
                model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
              },
            } as unknown as RawMessageStreamEvent;
            throw Object.assign(new Error('Invalid request'), {
              status: undefined,
              error: { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request' } },
            });
          })();
        }),
      },
    };
    const events = await collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    expect(callCount).toBe(1); // no backoff, no retry — surfaces immediately
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    // A non-overload error surfaces immediately — no retry, so no marker.
    expect(events.find((e) => e.type === 'stream.retry')).toBeUndefined();
  });

  it('aborts during the mid-stream retry backoff and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return midStreamOverloadStream();
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: abortController.signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(100); // first attempt overloads, enters backoff
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await resultPromise;

    expect(callCount).toBe(1); // aborted before the retry attempt
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });
});

// ─── Mid-stream clean-close retry (StreamIncompleteError, via runTurn) ────────
//
// A stream that emits content and then ENDS CLEANLY with neither a
// message_delta (stop_reason) nor a message_stop — an intermediary
// proxy/gateway/LB dropped the connection mid-generation. translate.ts converts
// this "no terminal signal" case into an in-band StreamIncompleteError error
// event (it is yielded, never thrown, so createWithRetry and the loop's catch
// never see it). This is DISTINCT from a TTFB stall (a first byte was seen) and
// from an overload (not an overloaded_error). These tests pin the bounded
// re-drive that keeps a single transient connection cut from failing the turn.
describe('runTurn mid-stream clean-close (StreamIncompleteError) retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Emits real content (so a first byte IS seen and the TTFB stall timer is
  // cleared) then ends without the trailing message_delta + message_stop.
  // makeTextStream's first four events are message_start, content_block_start,
  // text_delta, content_block_stop; slicing off the last two is exactly the
  // missing-terminal-signal cut translate.ts guards against.
  function midStreamCleanCloseStream(): AsyncIterable<RawMessageStreamEvent> {
    return fromArray(makeTextStream('partial output').slice(0, 4));
  }

  it('retries a mid-stream clean-close and succeeds on the next attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return callCount === 1
            ? midStreamCleanCloseStream()
            : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(3_000); // past the first 1s settle delay
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // Exactly one stream.retry marker so surfaces discard the cut attempt's
    // partial text before the recovered re-stream.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('exhausts the retry budget on a persistent clean-close and yields the error', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => midStreamCleanCloseStream()) },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000); // past all settle delays (1s + 2s)
    const events = await resultPromise;

    expect(client.messages.create).toHaveBeenCalledTimes(STREAM_INCOMPLETE_MAX_RETRIES + 1);
    // One stream.retry per re-drive; the final exhausted attempt yields the
    // error rather than another retry marker.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(STREAM_INCOMPLETE_MAX_RETRIES);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.name).toBe('StreamIncompleteError');
      expect(errorEvent.error.message).toContain('cut off mid-stream');
    }
  });

  it('aborts during the clean-close retry backoff and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return midStreamCleanCloseStream();
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: abortController.signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(100); // first attempt cuts, enters the settle delay
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await resultPromise;

    expect(callCount).toBe(1); // aborted before the retry attempt
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });
});
