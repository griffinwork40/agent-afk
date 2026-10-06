/**
 * Tests for {@link withTransientRetry}.
 *
 * All tests use injected sleep (opts.sleep) so there is no real timing
 * dependency and the suite runs in milliseconds.
 */
import { describe, it, expect, vi } from 'vitest';
import { withTransientRetry, type RetryInfo } from './transient-retry.js';

/** Injected sleep that resolves immediately (no real wait). */
const fastSleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {};

/** Build an Error that looks like an SDK APIConnectionError. */
function makeConnectionError(message = 'Connection error.'): Error {
  const err = new Error(message);
  err.name = 'APIConnectionError';
  Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionError' } });
  return err;
}

/** Build an error with a numeric HTTP status. */
function makeStatusError(status: number, message = 'Server error'): Error & { status: number } {
  const err = Object.assign(new Error(message), { status });
  return err as Error & { status: number };
}

/** Build an AbortError. */
function makeAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Build an error with a network code on a cause chain. */
function makeCodeError(code: string): Error {
  const cause = Object.assign(new Error('socket hang up'), { code });
  return Object.assign(new Error('network error'), { cause });
}

/** Build an error with a retry-after-ms header. */
function makeRetryAfterError(status: number, retryAfterMs: number): Error & { status: number } {
  const headers = { 'retry-after-ms': String(retryAfterMs) };
  return Object.assign(new Error('rate limited'), { status, headers });
}

describe('withTransientRetry — success paths', () => {
  it('returns the result immediately on first success', async () => {
    const attempt = vi.fn(async () => 'ok');
    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries an APIConnectionError-shaped error and succeeds on second try', async () => {
    const err = makeConnectionError();
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('recovered');
    const onRetry = vi.fn();

    const result = await withTransientRetry(attempt, { sleep: fastSleep, onRetry });
    expect(result).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 status error then succeeds', async () => {
    const err = makeStatusError(500);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 status error then succeeds', async () => {
    const err = makeStatusError(429);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 status error then succeeds', async () => {
    const err = makeStatusError(503);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('retries a 529 status error then succeeds', async () => {
    const err = makeStatusError(529);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('calls onRetry with correct attempt numbers', async () => {
    const err = makeStatusError(500);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('done');
    const retryInfos: RetryInfo[] = [];
    const onRetry = (info: RetryInfo): void => { retryInfos.push(info); };

    const result = await withTransientRetry(attempt, {
      maxRetries: 2,
      sleep: fastSleep,
      onRetry,
    });
    expect(result).toBe('done');
    expect(retryInfos).toHaveLength(2);
    expect(retryInfos[0]?.attempt).toBe(1);
    expect(retryInfos[1]?.attempt).toBe(2);
    expect(retryInfos[0]?.status).toBe(500);
  });

  it('honors a small retry-after hint by passing a delayMs >= hint to sleep', async () => {
    const hint = 200;
    const err = makeRetryAfterError(429, hint);
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const sleepArgs: number[] = [];
    const mockSleep = async (ms: number, _signal: AbortSignal): Promise<void> => {
      sleepArgs.push(ms);
    };

    await withTransientRetry(attempt, { sleep: mockSleep });
    expect(sleepArgs[0]).toBeGreaterThanOrEqual(hint);
  });

  it('retries an error with a retryable code in the cause chain', async () => {
    const err = makeCodeError('ECONNRESET');
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    const result = await withTransientRetry(attempt, { sleep: fastSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('withTransientRetry — exhaustion', () => {
  it('gives up after maxRetries and rethrows the last error', async () => {
    const err = makeStatusError(500);
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, { maxRetries: 2, sleep: fastSleep }),
    ).rejects.toThrow();
    // 1 initial + 2 retries = 3 total
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('gives up with maxRetries: 0 (no retries at all)', async () => {
    const err = makeStatusError(503);
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, { maxRetries: 0, sleep: fastSleep }),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('calls onExhausted with attempt === 1 when maxRetries is 0', async () => {
    // maxRetries:0 means the first (and only) attempt exhausts the budget
    // immediately; onExhausted must fire with attempt=1.
    const err = makeStatusError(503);
    const attempt = vi.fn().mockRejectedValue(err);
    const onExhausted = vi.fn();

    await expect(
      withTransientRetry(attempt, { maxRetries: 0, sleep: fastSleep, onExhausted }),
    ).rejects.toThrow();

    expect(onExhausted).toHaveBeenCalledTimes(1);
    const info = onExhausted.mock.calls[0]?.[0] as RetryInfo;
    // n === 0 === maxRetries at budget exhaustion → attempt = n+1 = 1
    expect(info.attempt).toBe(1);
    expect(info.delayMs).toBe(0);
    expect(info.status).toBe(503);
  });

  it('calls onExhausted exactly once when budget is spent', async () => {
    const err = makeStatusError(500);
    const attempt = vi.fn().mockRejectedValue(err);
    const onExhausted = vi.fn();

    await expect(
      withTransientRetry(attempt, { maxRetries: 2, sleep: fastSleep, onExhausted }),
    ).rejects.toThrow();

    expect(onExhausted).toHaveBeenCalledTimes(1);
    const info = onExhausted.mock.calls[0]?.[0] as RetryInfo;
    expect(info.attempt).toBe(3); // attempt n+1 when n === maxRetries (2)
    expect(info.status).toBe(500);
    expect(info.delayMs).toBe(0);
  });

  it('does NOT call onExhausted for a non-retryable error', async () => {
    const err = makeStatusError(400, 'bad request');
    const attempt = vi.fn().mockRejectedValue(err);
    const onExhausted = vi.fn();

    await expect(
      withTransientRetry(attempt, { sleep: fastSleep, onExhausted }),
    ).rejects.toThrow('bad request');

    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('does NOT call onExhausted when aborted mid-backoff', async () => {
    const controller = new AbortController();
    const err = makeStatusError(500);
    const attempt = vi.fn().mockRejectedValue(err);
    const onExhausted = vi.fn();

    const mockSleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {
      controller.abort();
    };

    await expect(
      withTransientRetry(attempt, {
        maxRetries: 3,
        signal: controller.signal,
        sleep: mockSleep,
        onExhausted,
      }),
    ).rejects.toThrow();
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

describe('withTransientRetry — non-retryable errors', () => {
  it('does NOT retry a 400 status error', async () => {
    const err = makeStatusError(400, 'bad request');
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, { sleep: fastSleep }),
    ).rejects.toThrow('bad request');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 401 status error', async () => {
    const err = makeStatusError(401, 'unauthorized');
    const attempt = vi.fn().mockRejectedValue(err);
    await expect(withTransientRetry(attempt, { sleep: fastSleep })).rejects.toThrow('unauthorized');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 409 Conflict error (semantically wrong for POST one-shots)', async () => {
    const err = makeStatusError(409, 'conflict');
    const attempt = vi.fn().mockRejectedValue(err);
    await expect(withTransientRetry(attempt, { sleep: fastSleep })).rejects.toThrow('conflict');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an AbortError', async () => {
    const err = makeAbortError();
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, { sleep: fastSleep }),
    ).rejects.toThrow('The operation was aborted');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an APIConnectionTimeoutError', async () => {
    // APIConnectionTimeoutError has status undefined and constructor name
    // APIConnectionTimeoutError — isConnectionPhaseNetworkError excludes it.
    const err = new Error('Request timed out.');
    Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionTimeoutError' } });
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, { sleep: fastSleep }),
    ).rejects.toThrow('Request timed out.');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('withTransientRetry — retry-after ceiling', () => {
  it('does NOT retry when retry-after exceeds retryAfterCeilingMs', async () => {
    const err = makeRetryAfterError(429, 15_000); // 15s hint > 10s ceiling
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(attempt, {
        retryAfterCeilingMs: 10_000,
        sleep: fastSleep,
      }),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('DOES retry when retry-after is below the ceiling', async () => {
    const err = makeRetryAfterError(429, 500); // 0.5s hint < 10s ceiling
    const attempt = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const result = await withTransientRetry(attempt, {
      retryAfterCeilingMs: 10_000,
      sleep: fastSleep,
    });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('withTransientRetry — shouldStop / signal abort', () => {
  it('stops (no new attempt) when shouldStop flips to true during the wait', async () => {
    const err = makeStatusError(500);
    let stopped = false;
    const attempt = vi.fn().mockRejectedValue(err);

    // sleep that flips stopped DURING the wait, simulating a timeout/abort
    const mockSleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {
      stopped = true;
    };

    await expect(
      withTransientRetry(attempt, {
        maxRetries: 3,
        shouldStop: () => stopped,
        sleep: mockSleep,
      }),
    ).rejects.toThrow();
    // The first attempt fires, then sleep flips stopped, post-wait check sees it
    // and throws without starting another attempt.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not start any attempt when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn().mockResolvedValue('ok');

    await expect(
      withTransientRetry(attempt, {
        signal: controller.signal,
        sleep: fastSleep,
      }),
    ).rejects.toThrow();
    expect(attempt).not.toHaveBeenCalled();
  });

  it('stops after the first attempt when the signal aborts during sleep', async () => {
    const controller = new AbortController();
    const err = makeStatusError(500);
    const attempt = vi.fn().mockRejectedValue(err);

    const mockSleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {
      controller.abort();
    };

    await expect(
      withTransientRetry(attempt, {
        maxRetries: 3,
        signal: controller.signal,
        sleep: mockSleep,
      }),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
