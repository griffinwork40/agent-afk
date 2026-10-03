/**
 * Unit tests for the openai-compatible retry helpers — specifically the
 * `retry-after` honoring added in #536, plus the pre-existing retryability
 * predicates and backoff schedule.
 */

import { describe, it, expect } from 'vitest';
import { APIError } from 'openai';
import {
  RETRY_AFTER_MAX_WAIT_MS,
  computeBackoffDelay,
  isRetryableConnectionError,
  isRetryableStreamError,
  isOpenAIOverloadError,
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

// ---------------------------------------------------------------------------
// isOpenAIOverloadError — status-less mid-stream overload (SDK SSE `error` throw)
// ---------------------------------------------------------------------------

/**
 * Exactly what openai's stream iterator throws on a mid-stream SSE payload
 * with an `error` key: `new APIError(undefined, data.error, undefined, headers)`.
 */
function sdkMidStreamError(body: Record<string, unknown>): APIError {
  return new APIError(undefined, body, undefined, new Headers());
}

describe('isOpenAIOverloadError', () => {
  it('matches the real SDK mid-stream throw for an overloaded server (message only)', () => {
    const err = sdkMidStreamError({
      message: 'Our servers are currently overloaded. Please try again later.',
    });
    expect(err.status).toBeUndefined();
    expect(isOpenAIOverloadError(err)).toBe(true);
  });

  it('matches code server_is_overloaded (copied onto the error by APIError)', () => {
    const err = sdkMidStreamError({ code: 'server_is_overloaded', message: 'busy' });
    expect(isOpenAIOverloadError(err)).toBe(true);
  });

  it('matches type service_unavailable_error and overloaded_error', () => {
    expect(isOpenAIOverloadError(sdkMidStreamError({ type: 'service_unavailable_error' }))).toBe(true);
    expect(isOpenAIOverloadError(sdkMidStreamError({ type: 'overloaded_error' }))).toBe(true);
  });

  it('matches a nested { error: { type } } body shape', () => {
    const err = sdkMidStreamError({ type: 'error', error: { type: 'overloaded_error', message: 'x' } });
    expect(isOpenAIOverloadError(err)).toBe(true);
    // Plain-object shape (no APIError copying) with nested code.
    expect(isOpenAIOverloadError({ error: { error: { code: 'server_is_overloaded' } } })).toBe(true);
  });

  it('matches a plain-object flat body on .error', () => {
    expect(isOpenAIOverloadError({ error: { type: 'service_unavailable_error' } })).toBe(true);
  });

  it('never matches when a numeric status is present (status paths own those)', () => {
    const e = apiError(503) as Error & { code?: string };
    e.code = 'server_is_overloaded';
    expect(isOpenAIOverloadError(e)).toBe(false);
    expect(isOpenAIOverloadError(apiError(529))).toBe(false);
    expect(isOpenAIOverloadError(new APIError(400, { message: 'overloaded' }, undefined, new Headers()))).toBe(false);
  });

  it('does not match an unrelated status-less error', () => {
    const err = sdkMidStreamError({ type: 'invalid_request_error', message: 'bad tool schema' });
    expect(isOpenAIOverloadError(err)).toBe(false);
    expect(isOpenAIOverloadError(new Error('network drop'))).toBe(false);
  });

  it('does not match non-objects', () => {
    expect(isOpenAIOverloadError(null)).toBe(false);
    expect(isOpenAIOverloadError(undefined)).toBe(false);
    expect(isOpenAIOverloadError('overloaded')).toBe(false);
    expect(isOpenAIOverloadError(529)).toBe(false);
  });
});

describe('isRetryableStreamError — status-less overload', () => {
  it('retries the SDK mid-stream overload throw', () => {
    const err = sdkMidStreamError({
      message: 'Our servers are currently overloaded. Please try again later.',
    });
    expect(isRetryableStreamError(err)).toBe(true);
  });

  it('still refuses unrelated status-less errors', () => {
    expect(isRetryableStreamError(sdkMidStreamError({ type: 'invalid_request_error', message: 'nope' }))).toBe(false);
  });

  it('connection-phase predicate is unchanged (still requires a status)', () => {
    expect(isRetryableConnectionError(sdkMidStreamError({ code: 'server_is_overloaded' }))).toBe(false);
  });
});
