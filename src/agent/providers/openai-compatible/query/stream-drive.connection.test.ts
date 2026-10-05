/**
 * Behavioral tests for runConnectionPhase — the openai-compatible provider's
 * connection-phase retry loop.
 *
 * Covers:
 *   (a) retries a statusless APIConnectionError-shaped error and succeeds
 *   (b) retries a 408 and a 504 then succeeds
 *   (c) retries the SDK connect timeout (APIConnectionTimeoutError) while the
 *       stream signal is live, but not once a watchdog aborted it
 *   (d) does NOT retry a 400
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runConnectionPhase } from './stream-drive.connection.js';
import { MAX_CONNECTION_RETRIES, __setRetryBaseDelay } from './retry.js';

// SDK error stand-ins with the exact constructor names and shapes the
// classifier keys on. No real SDK import (audit:sdk lock).
class APIConnectionError extends Error {
  readonly status: undefined = undefined;
  constructor(msg = 'Connection error.') {
    super(msg);
  }
}
class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super('Request timed out.');
  }
}
class APIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const emptyStream: AsyncIterable<never> = {
  async *[Symbol.asyncIterator]() { /* yields nothing */ },
};

afterEach(() => {
  vi.useRealTimers();
  __setRetryBaseDelay(null);
});

describe('runConnectionPhase — statusless connection errors', () => {
  it('retries a statusless APIConnectionError and succeeds on the next attempt', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      if (calls === 1) throw new APIConnectionError();
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('retries the SDK connect timeout (APIConnectionTimeoutError) while the stream signal is live', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      if (calls === 1) throw new APIConnectionTimeoutError();
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('gives up on a persistent connect timeout after MAX_CONNECTION_RETRIES', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      throw new APIConnectionTimeoutError();
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(createStream).toHaveBeenCalledTimes(MAX_CONNECTION_RETRIES + 1);
  });

  it('does NOT retry a timeout once a watchdog aborted the stream signal (TTFB owns it)', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      throw new APIConnectionTimeoutError();
    });
    const watchdog = new AbortController();
    watchdog.abort();
    const user = new AbortController();
    const p = runConnectionPhase(createStream, watchdog.signal, user.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(createStream).toHaveBeenCalledTimes(1);
  });
});

describe('runConnectionPhase — connection-phase status retries', () => {
  it('retries a 408 Request Timeout and succeeds', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      if (calls === 1) throw new APIError(408, 'Request Timeout');
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('retries a 504 Gateway Timeout and succeeds', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      if (calls === 1) throw new APIError(504, 'Gateway Timeout');
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 Bad Request (deterministic client error)', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      throw new APIError(400, 'Bad Request');
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(createStream).toHaveBeenCalledTimes(1);
  });
});
