/**
 * Bounded retry for the what-if analyst calls (predict, compile, discover,
 * Claude judge).
 *
 * `oneShotCompletion` deliberately has no retry policy, but a what-if run
 * issues dozens of analyst calls, often while other sessions share the same
 * rate limit, so a single 429 must not abort the whole run.
 *
 * Invariant: the backoff timer is REF'd. The CLI surface has nothing else
 * holding the event loop open during a backoff, so an unref'd sleep would let
 * the process exit mid-run with the promise pending.
 *
 * @module whatif/complete.retry
 */

import { parseRetryAfterMs } from '../agent/providers/shared/retry-after.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** True for rate-limit, overload, and transient server/network failures. */
export function isRetryableAnalystError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { name?: unknown }).name === 'AbortError') return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  const msg = String((err as { message?: unknown }).message ?? '').toLowerCase();
  return /rate limit|overloaded|econnreset|etimedout|socket hang up|connection error/.test(msg);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

/** Run `fn`, retrying retryable failures with exponential backoff + jitter. */
export async function withAnalystRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  const max = opts.maxDelayMs ?? 30_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryableAnalystError(err)) throw err;
      const hinted = parseRetryAfterMs(err);
      const backoff = Math.min(max, base * 2 ** i) * (0.75 + Math.random() * 0.5);
      await delay(Math.min(max, hinted ?? backoff), opts.signal);
    }
  }
  throw lastErr;
}
