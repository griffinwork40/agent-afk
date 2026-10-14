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

describe('runConnectionPhase — independent retry budgets', () => {
  it('a 429 still gets its own retry allowance after network failures consumed shared counter', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    // Scenario: MAX_CONNECTION_RETRIES network errors (all retried, then
    // recover), followed by a 429 rate-limit. With a shared `attempt` counter
    // the 429 would see attempt=MAX_CONNECTION_RETRIES and get zero retries.
    // With split counters the 429 sees overloadAttempts=0 and retries normally.
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      // Calls 1..MAX_CONNECTION_RETRIES: network errors (retried, not exhausted).
      if (calls <= MAX_CONNECTION_RETRIES) throw new APIConnectionError();
      // Call MAX_CONNECTION_RETRIES+1: network recovers, but a 429 arrives instead.
      if (calls === MAX_CONNECTION_RETRIES + 1) throw new APIError(429, 'Too Many Requests');
      // Call MAX_CONNECTION_RETRIES+2: success.
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    // With split counters the 429 retries on its own budget and succeeds.
    expect(result.ok).toBe(true);
    // MAX_CONNECTION_RETRIES network retries + 1 failed 429 + 1 success
    expect(createStream).toHaveBeenCalledTimes(MAX_CONNECTION_RETRIES + 2);
  });

  it('exhausting network retries does not affect overload retry budget', async () => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
    // Exhaust the full network budget, then verify a 429 on a fresh connection
    // attempt still gets its own full retry allowance.
    let calls = 0;
    const createStream = vi.fn(async (_signal: AbortSignal) => {
      calls++;
      // Calls 1..MAX_CONNECTION_RETRIES: network errors, all retried.
      if (calls <= MAX_CONNECTION_RETRIES) throw new APIConnectionError();
      // Calls MAX+1..MAX+MAX: 429 rate-limit errors (MAX of them, all retried).
      // With a shared counter, the first 429 at call MAX+1 would see
      // attempt==MAX, so `attempt < MAX` is false and it gets zero retries.
      if (calls <= MAX_CONNECTION_RETRIES + MAX_CONNECTION_RETRIES) throw new APIError(429, 'Too Many Requests');
      // Call MAX+MAX+1: succeed.
      return emptyStream;
    });
    const ac = new AbortController();
    const p = runConnectionPhase(createStream, ac.signal, ac.signal, undefined, 'test-model');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    // MAX network retries + MAX overload retries + 1 success
    expect(createStream).toHaveBeenCalledTimes(MAX_CONNECTION_RETRIES * 2 + 1);
  });
});
