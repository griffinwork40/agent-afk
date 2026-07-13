/**
 * Unit tests for the openai-compatible retry helpers — specifically the
 * `retry-after` honoring added in #536, plus the pre-existing retryability
 * predicates and backoff schedule.
 */

import { describe, it, expect } from 'vitest';
import {
  RETRY_AFTER_MAX_WAIT_MS,
  computeBackoffDelay,
  isRetryableConnectionError,
  isRetryableStreamError,
  retryAfterDelayMs,
  __setRetryBaseDelay,
} from './retry.js';

/** Minimal APIError-shaped stub: a status + a headers bag (record or Headers). */
function apiError(status: number, headers?: Record<string, string> | Headers): Error {
  const e = new Error(`http ${status}`) as Error & { status: number; headers?: unknown };
  e.status = status;
  if (headers !== undefined) e.headers = headers;
  return e;
}

describe('retryAfterDelayMs — server backoff-hint honoring (#536)', () => {
  it('returns undefined when the error carries no retry-after header', () => {
    expect(retryAfterDelayMs(apiError(429))).toBeUndefined();
    expect(retryAfterDelayMs(apiError(503, { 'x-other': '1' }))).toBeUndefined();
    expect(retryAfterDelayMs(null)).toBeUndefined();
    expect(retryAfterDelayMs('nope')).toBeUndefined();
  });

  it('honors retry-after in seconds (record-shaped headers)', () => {
    expect(retryAfterDelayMs(apiError(429, { 'retry-after': '2' }))).toBe(2_000);
  });

  it('honors retry-after-ms in milliseconds and prefers it over retry-after', () => {
    expect(retryAfterDelayMs(apiError(429, { 'retry-after-ms': '1500' }))).toBe(1_500);
    expect(
      retryAfterDelayMs(apiError(429, { 'retry-after-ms': '1500', 'retry-after': '99' })),
    ).toBe(1_500);
  });

  it('honors a Headers-object shape (not just plain records)', () => {
    expect(retryAfterDelayMs(apiError(429, new Headers({ 'retry-after': '3' })))).toBe(3_000);
  });

  it('clamps a pathological hint to RETRY_AFTER_MAX_WAIT_MS', () => {
    // 1 hour advised → clamped to the 120s cap so a hostile header cannot park the turn.
    expect(retryAfterDelayMs(apiError(429, { 'retry-after': '3600' }))).toBe(RETRY_AFTER_MAX_WAIT_MS);
    expect(RETRY_AFTER_MAX_WAIT_MS).toBe(120_000);
  });

  it('is deterministic (no jitter) so the wait is reproducible', () => {
    const e = apiError(429, { 'retry-after': '5' });
    expect(retryAfterDelayMs(e)).toBe(retryAfterDelayMs(e));
    expect(retryAfterDelayMs(e)).toBe(5_000);
  });
});

describe('retryability predicates (unchanged)', () => {
  it('treats 429/5xx with an explicit status as retryable, status-less errors as not', () => {
    expect(isRetryableConnectionError(apiError(429))).toBe(true);
    expect(isRetryableConnectionError(apiError(503))).toBe(true);
    expect(isRetryableStreamError(apiError(500))).toBe(true);
    expect(isRetryableConnectionError(apiError(400))).toBe(false);
    expect(isRetryableConnectionError(new Error('network drop'))).toBe(false);
  });
});

describe('computeBackoffDelay fallback (unchanged)', () => {
  it('is exponential in the attempt index off the base delay', () => {
    __setRetryBaseDelay(1_000);
    expect(computeBackoffDelay(0)).toBe(1_000);
    expect(computeBackoffDelay(1)).toBe(2_000);
    expect(computeBackoffDelay(2)).toBe(4_000);
    __setRetryBaseDelay(null); // restore production default
  });
});
