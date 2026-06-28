/**
 * Tests for retryFetch — the web-layer self-unsticking wrapper.
 *
 * Strategy: mock fetchFn and inject a no-op `sleep` so retries don't wait on
 * real timers. Asserts call counts (retry behavior), terminal statuses, and the
 * abort-is-terminal invariant.
 */

import { describe, it, expect, vi } from 'vitest';
import { retryFetch } from './retryFetch.js';
import type { FetchFn } from './types.js';

const noSleep = (): Promise<void> => Promise.resolve();

function res(status: number, body = 'ok', headers?: Record<string, string>): Response {
  return new Response(body, { status, ...(headers ? { headers } : {}) });
}

describe('retryFetch', () => {
  it('returns immediately on success (one call, no retry)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200));
    const r = await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep: noSleep });
    expect(r.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable status (404)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(404));
    const r = await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep: noSleep });
    expect(r.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable status (503) then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, 'good'));
    const r = await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep: noSleep });
    expect(r.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(200));
    const r = await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep: noSleep });
    expect(r.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns the last non-ok response after exhausting retries on a retryable status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(429));
    const r = await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { retries: 2, sleep: noSleep });
    expect(r.status).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws the last error after exhausting retries on network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(
      retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { retries: 2, sleep: noSleep }),
    ).rejects.toThrow('down');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('defaults to 3 retries (4 total attempts)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(502));
    await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep: noSleep });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('is terminal on a pre-aborted signal (never calls fetch)', async () => {
    const ac = new AbortController();
    ac.abort(new Error('canceled'));
    const fetchFn = vi.fn().mockResolvedValue(res(200));
    await expect(
      retryFetch(fetchFn as unknown as FetchFn, 'https://x', { signal: ac.signal }, { sleep: noSleep }),
    ).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not retry once the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn().mockImplementation(() => {
      ac.abort(new Error('canceled'));
      return Promise.reject(new Error('aborted fetch'));
    });
    await expect(
      retryFetch(fetchFn as unknown as FetchFn, 'https://x', { signal: ac.signal }, { sleep: noSleep }),
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1); // aborted → not retried
  });

  it('honors a numeric Retry-After header for the backoff wait', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(503, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200));
    await retryFetch(fetchFn as unknown as FetchFn, 'https://x', {}, { sleep });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });
});
