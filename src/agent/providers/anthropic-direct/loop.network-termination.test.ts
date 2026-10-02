// Mid-stream transport termination re-drive (#2776).
//
// undici's fetch throws `TypeError: terminated` (cause: a SocketError with
// code UND_ERR_SOCKET, or an ECONNRESET) when the response body socket closes
// after headers arrived. translate.ts converts that throw into an in-band
// `error` event. Before #2776 it matched none of the retry classes and ended
// the session; these tests pin that it now shares the StreamIncompleteError
// re-drive and budget, and that the TTFB / stall / user-abort branches still
// claim a termination they caused.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import { STREAM_INCOMPLETE_MAX_RETRIES } from './loop/retry-budget.js';
import { isMidStreamNetworkTermination, isMidStreamCut } from './loop/network-termination.js';
import { StreamIncompleteError } from '../../../utils/errors.js';
import type { AnthropicClientLike } from './types.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';

/** The exact shape undici throws on a mid-body socket close. */
function undiciTerminated(): TypeError {
  const socketErr = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return new TypeError('terminated', { cause: socketErr });
}

/** Streams real content (first byte seen), then the socket dies mid-read. */
function midStreamTerminatedStream(err: Error = undiciTerminated()): AsyncIterable<RawMessageStreamEvent> {
  const prefix = makeTextStream('partial output').slice(0, 3); // start, block_start, delta
  return (async function* () {
    for (const evt of prefix) yield evt;
    throw err;
  })();
}

function run(client: AnthropicClientLike, signal: AbortSignal = new AbortController().signal) {
  return collect(
    runTurn({
      client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
      toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
      model: 'claude-test', maxTokens: 1024, headers: {}, signal, ctx,
    }),
  );
}

describe('isMidStreamNetworkTermination', () => {
  it("matches undici's TypeError('terminated')", () => {
    expect(isMidStreamNetworkTermination(new TypeError('terminated'))).toBe(true);
    expect(isMidStreamNetworkTermination(undiciTerminated())).toBe(true);
  });

  it('matches a termination code on the error itself or deeper in the cause chain', () => {
    expect(isMidStreamNetworkTermination(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    const inner = Object.assign(new Error('closed'), { code: 'UND_ERR_CLOSED' });
    const outer = new Error('wrapped', { cause: new Error('middle', { cause: inner }) });
    expect(isMidStreamNetworkTermination(outer)).toBe(true);
  });

  it('does NOT match unrelated errors (stays narrower than isNetworkError)', () => {
    expect(isMidStreamNetworkTermination(new TypeError('boom'))).toBe(false);
    expect(isMidStreamNetworkTermination(new Error('terminated'))).toBe(false); // not a TypeError
    expect(isMidStreamNetworkTermination(new Error('network failure'))).toBe(false);
    expect(isMidStreamNetworkTermination(new Error('connect timeout'))).toBe(false);
    expect(isMidStreamNetworkTermination(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isMidStreamNetworkTermination(null)).toBe(false);
    expect(isMidStreamNetworkTermination('terminated')).toBe(false);
  });

  it('isMidStreamCut covers both a clean close and a transport termination', () => {
    expect(isMidStreamCut(new StreamIncompleteError('ended without a terminal message'))).toBe(true);
    expect(isMidStreamCut(undiciTerminated())).toBe(true);
    expect(isMidStreamCut(new TypeError('boom'))).toBe(false);
  });

  it('terminates on a self-referential cause instead of looping', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(isMidStreamNetworkTermination(e)).toBe(false);
  });
});

describe('runTurn mid-stream network termination re-drive (#2776)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-drives a mid-stream TypeError: terminated and succeeds on the next attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return callCount === 1 ? midStreamTerminatedStream() : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = run(client);
    await vi.advanceTimersByTimeAsync(3_000); // past the first 1s settle delay
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('re-drives a bare ECONNRESET thrown mid-stream', async () => {
    let callCount = 0;
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return callCount === 1 ? midStreamTerminatedStream(reset) : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = run(client);
    await vi.advanceTimersByTimeAsync(3_000);
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });

  it('exhausts the shared budget and yields the ORIGINAL transport error', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => midStreamTerminatedStream()) },
    };
    const resultPromise = run(client);
    await vi.advanceTimersByTimeAsync(10_000); // past all settle delays (1s + 2s)
    const events = await resultPromise;

    expect(client.messages.create).toHaveBeenCalledTimes(STREAM_INCOMPLETE_MAX_RETRIES + 1);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(STREAM_INCOMPLETE_MAX_RETRIES);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      // Not normalized into StreamIncompleteError: the trace keeps the diagnosis.
      expect(errorEvent.error.name).toBe('TypeError');
      expect(errorEvent.error.message).toBe('terminated');
    }
  });

  it('does NOT re-drive an unrelated mid-stream TypeError', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => midStreamTerminatedStream(new TypeError('boom'))) },
    };
    const events = await run(client);

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    expect(events.find((e) => e.type === 'stream.retry')).toBeUndefined();
  });

  it('aborts during the re-drive settle delay and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return midStreamTerminatedStream();
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = run(client, abortController.signal);
    await vi.advanceTimersByTimeAsync(100); // first attempt terminates, enters the settle delay
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await resultPromise;

    expect(callCount).toBe(1);
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });
});

// The stall watchdog tears the socket down itself; undici can then surface
// that as `TypeError: terminated`. The stall branch runs first and must win:
// a mid-stream stall is deliberately NOT retried (#762).
describe('runTurn stall-caused termination stays fatal (#2776 x #762)', () => {
  const STALL_KEY = 'AFK_MODEL_STALL_TIMEOUT_MS';
  let savedStall: string | undefined;
  beforeEach(() => {
    savedStall = process.env[STALL_KEY];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (savedStall === undefined) delete process.env[STALL_KEY];
    else process.env[STALL_KEY] = savedStall;
  });

  function stallThenTerminate(signal: AbortSignal): AsyncIterable<RawMessageStreamEvent> {
    const prefix = makeTextStream('partial').slice(0, 3);
    return {
      [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
        let i = 0;
        return {
          next(): Promise<IteratorResult<RawMessageStreamEvent>> {
            if (i < prefix.length) {
              const value = prefix[i]!;
              i++;
              return Promise.resolve({ done: false, value });
            }
            // Stall until the watchdog aborts the request, then fail the way
            // undici does when its socket is torn down mid-read.
            return new Promise((_resolve, reject) => {
              if (signal.aborted) { reject(undiciTerminated()); return; }
              signal.addEventListener('abort', () => reject(undiciTerminated()), { once: true });
            });
          },
        };
      },
    };
  }

  it('surfaces the stall error and does not re-drive', async () => {
    process.env[STALL_KEY] = '60000';
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) =>
          stallThenTerminate((opts as { signal: AbortSignal }).signal)),
      },
    };
    const resultPromise = run(client);
    await vi.advanceTimersByTimeAsync(61_000);
    const events = await resultPromise;

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'stream.retry')).toBeUndefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(String((errorEvent as { error: Error }).error.message)).toMatch(/stalled/i);
  });
});
