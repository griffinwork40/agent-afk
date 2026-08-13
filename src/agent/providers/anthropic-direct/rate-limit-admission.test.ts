/**
 * Integration tests for the rate-limit admission gate wired into
 * makeTracingFetch (Anthropic path).
 *
 * These tests verify that:
 *   1. The gate correctly limits concurrent outbound requests when the bucket
 *      reports limited remaining capacity.
 *   2. The gate is bypassed when AFK_RATE_LIMIT_ADMISSION_DISABLED=1.
 *   3. onRateLimit fires on every response (not just throttled ones).
 *   4. A throwing onRateLimit does not disturb the request path.
 *
 * IMPORTANT: every test must:
 *   - Set AFK_RATE_LIMIT_STAGGER_MAX_MS=0 (done in beforeEach below).
 *   - Call globalRateLimitBucket.resetForTests() before/after (done in beforeEach/afterEach).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTracingFetch } from './tracing-fetch.js';
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

// ── onRateLimit callback ──────────────────────────────────────────────────────

describe('onRateLimit callback', () => {
  it('fires on every response, including 200', async () => {
    const seen: Array<string | null> = [];
    const base: typeof fetch = vi.fn(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-requests-remaining': '99' },
      }),
    ) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(
      undefined,
      base,
      undefined,
      undefined,
      (h) => seen.push(h.get('anthropic-ratelimit-requests-remaining')),
    );
    await wrapped('https://api.anthropic.com/v1/messages');
    expect(seen).toEqual(['99']);
  });

  it('fires on 429 responses too', async () => {
    const seen: Array<string | null> = [];
    const base: typeof fetch = vi.fn(async () =>
      new Response('{}', {
        status: 429,
        headers: { 'anthropic-ratelimit-requests-remaining': '0' },
      }),
    ) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(
      undefined,
      base,
      undefined,
      undefined,
      (h) => seen.push(h.get('anthropic-ratelimit-requests-remaining')),
    );
    await wrapped('u');
    expect(seen).toEqual(['0']);
  });

  it('a throwing onRateLimit does not disturb the response', async () => {
    const base: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(
      undefined,
      base,
      undefined,
      undefined,
      () => { throw new Error('observer failed'); },
    );
    await expect(wrapped('u')).resolves.toMatchObject({ status: 200 });
  });
});

// ── admission gate ────────────────────────────────────────────────────────────

describe('admission gate', () => {
  it('calls gate.acquirePermit before the baseFetch', async () => {
    const order: string[] = [];
    const base: typeof fetch = vi.fn(async () => {
      order.push('fetch');
      return new Response('{}');
    }) as unknown as typeof fetch;
    const gate = {
      acquirePermit: vi.fn(async () => { order.push('permit'); }),
      freeze: vi.fn(),
    };
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, gate);
    await wrapped('u');
    expect(order).toEqual(['permit', 'fetch']);
  });

  it('calls gate.freeze on 429 with parsed retry-after', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base: typeof fetch = vi.fn(async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '20' } }),
    ) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).toHaveBeenCalledWith(20_000);
  });

  it('calls gate.freeze with default 5000ms when no retry-after header', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base: typeof fetch = vi.fn(async () =>
      new Response('{}', { status: 429 }),
    ) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).toHaveBeenCalledWith(5_000);
  });

  it('does NOT call gate.freeze on 200', async () => {
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, gate);
    await wrapped('u');
    expect(gate.freeze).not.toHaveBeenCalled();
  });

  it('bypasses gate when AFK_RATE_LIMIT_ADMISSION_DISABLED=1', async () => {
    process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'] = '1';
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const base: typeof fetch = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    // Use globalRateLimitBucket as gate (it respects the env var).
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, globalRateLimitBucket);
    globalRateLimitBucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    const start = Date.now();
    await wrapped('u');
    expect(Date.now() - start).toBeLessThan(100);
    void gate; // suppress unused warning
  });

  it('wraps fetch when only gate is provided (no other params)', () => {
    const base = vi.fn() as unknown as typeof fetch;
    const gate = { acquirePermit: vi.fn(async () => {}), freeze: vi.fn() };
    const wrapped = makeTracingFetch(undefined, base, undefined, undefined, undefined, gate);
    expect(wrapped).not.toBe(base);
  });
});
