/**
 * Tests for the pure header-parsing functions in rate-limit-headers.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseAnthropicRateLimitHeaders,
  parseOpenAIRateLimitHeaders,
} from './rate-limit-headers.js';

function makeHeaders(record: Record<string, string>): Headers {
  return new Headers(record);
}

describe('parseAnthropicRateLimitHeaders', () => {
  it('returns undefined when no rate-limit headers are present', () => {
    expect(parseAnthropicRateLimitHeaders(makeHeaders({}))).toBeUndefined();
  });

  it('parses requests-remaining and requests-limit', () => {
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({
        'anthropic-ratelimit-requests-remaining': '42',
        'anthropic-ratelimit-requests-limit': '100',
      }),
    );
    expect(snap).toBeDefined();
    expect(snap!.requestsRemaining).toBe(42);
    expect(snap!.requestsLimit).toBe(100);
  });

  it('parses ISO-8601 reset timestamps to epoch ms', () => {
    const isoTs = '2025-01-01T00:01:00Z';
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({
        'anthropic-ratelimit-requests-remaining': '5',
        'anthropic-ratelimit-requests-reset': isoTs,
      }),
    );
    expect(snap!.requestsResetAt).toBe(Date.parse(isoTs));
  });

  it('parses input-token and output-token headers', () => {
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({
        'anthropic-ratelimit-input-tokens-remaining': '1000',
        'anthropic-ratelimit-output-tokens-remaining': '500',
      }),
    );
    expect(snap!.inputTokensRemaining).toBe(1000);
    expect(snap!.outputTokensRemaining).toBe(500);
  });

  it('returns undefined when only unrelated headers are present', () => {
    expect(
      parseAnthropicRateLimitHeaders(
        makeHeaders({ 'content-type': 'application/json' }),
      ),
    ).toBeUndefined();
  });

  it('ignores malformed counts and returns undefined for them', () => {
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({
        'anthropic-ratelimit-requests-remaining': 'not-a-number',
        'anthropic-ratelimit-input-tokens-remaining': '200',
      }),
    );
    expect(snap!.requestsRemaining).toBeUndefined();
    expect(snap!.inputTokensRemaining).toBe(200);
  });

  it('ignores malformed ISO-8601 reset dates (does not throw)', () => {
    expect(() =>
      parseAnthropicRateLimitHeaders(
        makeHeaders({
          'anthropic-ratelimit-requests-remaining': '1',
          'anthropic-ratelimit-requests-reset': 'garbage-date',
        }),
      ),
    ).not.toThrow();
  });

  it('parses anthropic-ratelimit-input-tokens-limit into inputTokensLimit', () => {
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({
        'anthropic-ratelimit-input-tokens-remaining': '50000',
        'anthropic-ratelimit-input-tokens-limit': '200000',
      }),
    );
    expect(snap).toBeDefined();
    expect(snap!.inputTokensRemaining).toBe(50_000);
    expect(snap!.inputTokensLimit).toBe(200_000);
  });

  it('does not set inputTokensLimit when the header is absent', () => {
    const snap = parseAnthropicRateLimitHeaders(
      makeHeaders({ 'anthropic-ratelimit-input-tokens-remaining': '1000' }),
    );
    expect(snap!.inputTokensLimit).toBeUndefined();
  });
});

describe('parseOpenAIRateLimitHeaders', () => {
  it('returns undefined when no x-ratelimit headers are present', () => {
    expect(parseOpenAIRateLimitHeaders(makeHeaders({}))).toBeUndefined();
  });

  it('parses remaining requests and limit', () => {
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-limit-requests': '200',
      }),
    );
    expect(snap!.requestsRemaining).toBe(50);
    expect(snap!.requestsLimit).toBe(200);
  });

  it('parses duration "30s" to epoch ms (approx current + 30s)', () => {
    const before = Date.now();
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-requests': '1',
        'x-ratelimit-reset-requests': '30s',
      }),
    );
    const after = Date.now();
    expect(snap!.requestsResetAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(snap!.requestsResetAt).toBeLessThanOrEqual(after + 30_000);
  });

  it('parses duration "1m3s" correctly', () => {
    const before = Date.now();
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-requests': '1',
        'x-ratelimit-reset-requests': '1m3s',
      }),
    );
    const after = Date.now();
    const expected = 63_000;
    expect(snap!.requestsResetAt).toBeGreaterThanOrEqual(before + expected);
    expect(snap!.requestsResetAt).toBeLessThanOrEqual(after + expected);
  });

  it('parses duration "1h2m3s" correctly', () => {
    const before = Date.now();
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-tokens': '100',
        'x-ratelimit-reset-tokens': '1h2m3s',
      }),
    );
    const after = Date.now();
    const expected = 3600_000 + 120_000 + 3_000;
    expect(snap!.inputTokensResetAt).toBeGreaterThanOrEqual(before + expected);
    expect(snap!.inputTokensResetAt).toBeLessThanOrEqual(after + expected);
  });

  it('parses ISO-8601 reset timestamps via the x-ratelimit path', () => {
    const isoTs = '2025-06-01T00:00:00Z';
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-requests': '3',
        'x-ratelimit-reset-requests': isoTs,
      }),
    );
    expect(snap!.requestsResetAt).toBe(Date.parse(isoTs));
  });

  it('maps token remaining to inputTokensRemaining (OpenAI combined TPM)', () => {
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({ 'x-ratelimit-remaining-tokens': '8000' }),
    );
    expect(snap!.inputTokensRemaining).toBe(8000);
  });

  it('returns undefined on entirely unrelated headers', () => {
    expect(
      parseOpenAIRateLimitHeaders(makeHeaders({ 'content-type': 'text/plain' })),
    ).toBeUndefined();
  });

  it('ignores malformed counts without throwing', () => {
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-requests': 'abc',
        'x-ratelimit-remaining-tokens': '42',
      }),
    );
    expect(snap!.requestsRemaining).toBeUndefined();
    expect(snap!.inputTokensRemaining).toBe(42);
  });

  it('ignores malformed duration strings without throwing', () => {
    expect(() =>
      parseOpenAIRateLimitHeaders(
        makeHeaders({
          'x-ratelimit-remaining-requests': '1',
          'x-ratelimit-reset-requests': 'not-a-duration',
        }),
      ),
    ).not.toThrow();
  });

  it('parses x-ratelimit-limit-tokens into inputTokensLimit', () => {
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({
        'x-ratelimit-remaining-tokens': '8000',
        'x-ratelimit-limit-tokens': '90000',
      }),
    );
    expect(snap).toBeDefined();
    expect(snap!.inputTokensRemaining).toBe(8_000);
    expect(snap!.inputTokensLimit).toBe(90_000);
  });

  it('does not set inputTokensLimit when x-ratelimit-limit-tokens is absent', () => {
    const snap = parseOpenAIRateLimitHeaders(
      makeHeaders({ 'x-ratelimit-remaining-tokens': '1000' }),
    );
    expect(snap!.inputTokensLimit).toBeUndefined();
  });
});

// Suppress unused-import warnings in this test file.
void vi.fn;
void beforeEach;
void afterEach;
