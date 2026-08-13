/**
 * Tests for makeOpenAITracingFetch — the OpenAI-compatible provider's
 * fetch wrapper that feeds the rate-limit admission bucket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeOpenAITracingFetch } from './tracing-fetch.js';
import { globalRateLimitBucket } from '../shared/rate-limit-bucket.js';

beforeEach(() => {
  process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'] = '0';
  delete process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'];
  globalRateLimitBucket.resetForTests();
});

afterEach(() => {
  delete process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'];
  delete process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'];
  globalRateLimitBucket.resetForTests();
});

function mockFetch(status: number, headers?: Record<string, string>): typeof fetch {
  return vi.fn(async () => new Response('{}', headers ? { status, headers } : { status })) as unknown as typeof fetch;
}

describe('makeOpenAITracingFetch', () => {
  it('returns base fetch unchanged when no callbacks or gate are provided', () => {
    const base = vi.fn() as unknown as typeof fetch;
    expect(makeOpenAITracingFetch(base)).toBe(base);
  });

  it('wraps when only onRateLimit is provided', () => {
    const base = vi.fn() as unknown as typeof fetch;
    expect(makeOpenAITracingFetch(base, undefined, () => {})).not.toBe(base);
  });

  it('wraps when only gate is provided', () => {
    const base = vi.fn() as unknown as typeof fetch;
    const gate = { acquirePermit: vi.fn(), freeze: vi.fn() };
    expect(makeOpenAITracingFetch(base, undefined, undefined, gate)).not.toBe(base);
  });

  it('invokes onRateLimit on every response (not just throttled)', async () => {
    const seen: Array<string | null> = [];
    const base = mockFetch(200, { 'x-ratelimit-remaining-requests': '42' });
    const wrapped = makeOpenAITracingFetch(
      base,
      undefined,
      (h) => seen.push(h.get('x-ratelimit-remaining-requests')),
    );
    await wrapped('https://api.openai.com/v1/chat/completions');
    expect(seen).toEqual(['42']);
  });

  it('a throwing onRateLimit does not disturb the request path', async () => {
    const base = mockFetch(200);
    const wrapped = makeOpenAITracingFetch(base, undefined, () => {
      throw new Error('observer exploded');
    });
    await expect(wrapped('https://api.openai.com/v1/chat/completions')).resolves.toMatchObject({
      status: 200,
    });
  });

  it('invokes onThrottle on 429', async () => {
    const seen: Array<{ status: number; retryAfterMs?: number }> = [];
    const base = mockFetch(429, { 'retry-after': '10' });
    const wrapped = makeOpenAITracingFetch(base, (info) => seen.push(info));
    await wrapped('https://api.openai.com/v1/chat/completions');
    expect(seen).toEqual([{ status: 429, retryAfterMs: 10_000 }]);
  });

  it('does NOT invoke onThrottle on 200', async () => {
    const seen: unknown[] = [];
    const base = mockFetch(200);
    const wrapped = makeOpenAITracingFetch(base, (info) => seen.push(info));
    await wrapped('u');
    expect(seen).toHaveLength(0);
  });

  it('invokes gate.acquirePermit before the baseFetch', async () => {
    const order: string[] = [];
    const base: typeof fetch = vi.fn(async () => {
      order.push('fetch');
      return new Response('{}');
    }) as unknown as typeof fetch;
    const gate = {
      acquirePermit: vi.fn(async () => { order.push('permit'); }),
      freeze: vi.fn(),
    };
    const wrapped = makeOpenAITracingFetch(base, undefined, undefined, gate);
    await wrapped('u');
    expect(order).toEqual(['permit', 'fetch']);
  });

  it('calls gate.freeze on 429', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base = mockFetch(429, { 'retry-after': '5' });
    const wrapped = makeOpenAITracingFetch(base, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).toHaveBeenCalledWith(5_000);
  });

  it('calls gate.freeze with default 5000ms when no retry-after header', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base = mockFetch(429);
    const wrapped = makeOpenAITracingFetch(base, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).toHaveBeenCalledWith(5_000);
  });

  it('does NOT call gate.freeze on non-429 responses', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base = mockFetch(200);
    const wrapped = makeOpenAITracingFetch(base, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).not.toHaveBeenCalled();
  });

  it('a throwing onThrottle does not disturb the response', async () => {
    const base = mockFetch(503);
    const wrapped = makeOpenAITracingFetch(base, () => {
      throw new Error('boom');
    });
    await expect(wrapped('u')).resolves.toMatchObject({ status: 503 });
  });
});
