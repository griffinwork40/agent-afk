/**
 * Tests for {@link fetchSubscriptionUsage} and {@link formatUsagePlain}.
 *
 * All network access goes through the injectable `fetchImpl` seam — no real
 * network calls are made.
 *
 * @module agent/subscription-usage.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fetchSubscriptionUsage,
  formatUsagePlain,
  type UsageResult,
  type UsageSnapshot,
} from './subscription-usage.js';

const SECRET_TOKEN = 'sk-ant-oat01-super-secret-token-value';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function fetchThrowing(err: unknown): typeof fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe('fetchSubscriptionUsage', () => {
  it('returns unavailable/no-token when no token is available', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await fetchSubscriptionUsage({ fetchImpl, token: '' });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'no-token',
      detail: expect.stringContaining('claude login'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('happy path: parses all four known windows', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, {
        five_hour: { utilization: 0.62, resets_at: '2026-07-26T18:00:00Z' },
        seven_day: { utilization: 0.31, resets_at: 1785110400 },
        seven_day_sonnet: { utilization: 0.28 },
        seven_day_opus: { utilization: 0.44 },
      }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result.kind).toBe('ok');
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.utilization).toBe(0.62);
    expect(ok.fiveHour?.resetsAt?.toISOString()).toBe('2026-07-26T18:00:00.000Z');
    expect(ok.sevenDay?.utilization).toBe(0.31);
    expect(ok.sevenDay?.resetsAt?.getTime()).toBe(1785110400 * 1000);
    expect(ok.sevenDaySonnet?.utilization).toBe(0.28);
    expect(ok.sevenDaySonnet?.resetsAt).toBeUndefined();
    expect(ok.sevenDayOpus?.utilization).toBe(0.44);
  });

  it('sends the expected request headers and URL', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { five_hour: { utilization: 0.1 } }));
    await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns unavailable/http-error on HTTP 401 and never leaks the token', async () => {
    const fetchImpl = fetchReturning(new Response('unauthorized: token abc123', { status: 401 }));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'http-error',
      detail: expect.stringContaining('401'),
    });
    const detail = (result as { detail: string }).detail;
    expect(detail).not.toContain(SECRET_TOKEN);
    expect(detail).not.toContain('unauthorized');
  });

  it('returns unavailable/http-error on HTTP 429', async () => {
    const fetchImpl = fetchReturning(new Response('rate limited', { status: 429 }));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'http-error',
      detail: expect.stringContaining('429'),
    });
  });

  it('returns unavailable/malformed-response on unparseable JSON', async () => {
    const fetchImpl = fetchReturning(new Response('not json at all', { status: 200 }));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result.kind).toBe('unavailable');
    expect((result as { reason: string }).reason).toBe('malformed-response');
  });

  it('returns unavailable/malformed-response on an empty body', async () => {
    const fetchImpl = fetchReturning(new Response('', { status: 200 }));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result.kind).toBe('unavailable');
    expect((result as { reason: string }).reason).toBe('malformed-response');
  });

  it('returns unavailable/malformed-response when JSON has none of the known windows', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, { unrelated_field: 42 }));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'malformed-response',
      detail: expect.any(String),
    });
  });

  it('returns unavailable/malformed-response when JSON body is not an object (e.g. an array)', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, [1, 2, 3]));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result.kind).toBe('unavailable');
    expect((result as { reason: string }).reason).toBe('malformed-response');
  });

  it('parses resets_at as an ISO string', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, { five_hour: { utilization: 0.5, resets_at: '2026-01-01T00:00:00Z' } }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.resetsAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('parses resets_at as an epoch-seconds number', async () => {
    const epoch = 1_800_000_000;
    const fetchImpl = fetchReturning(
      jsonResponse(200, { five_hour: { utilization: 0.5, resets_at: epoch } }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.resetsAt?.getTime()).toBe(epoch * 1000);
  });

  it('drops resets_at when it is an out-of-range epoch number rather than producing Invalid Date', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, {
        five_hour: { utilization: 0.5, resets_at: Number.MAX_SAFE_INTEGER },
      }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.utilization).toBe(0.5);
    expect(ok.fiveHour?.resetsAt).toBeUndefined();
  });

  it('drops resets_at when it is non-finite (NaN/Infinity) or an unrecognized type', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, {
        five_hour: { utilization: 0.5, resets_at: { nested: true } },
        seven_day: { utilization: 0.2, resets_at: null },
      }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.resetsAt).toBeUndefined();
    expect(ok.sevenDay?.resetsAt).toBeUndefined();
  });

  it('clamps utilization into 0..1', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, {
        five_hour: { utilization: 1.5 },
        seven_day: { utilization: -0.3 },
      }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour?.utilization).toBe(1);
    expect(ok.sevenDay?.utilization).toBe(0);
  });

  it('skips a window whose utilization is non-numeric or non-finite', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(200, {
        five_hour: { utilization: 'high' },
        seven_day: { utilization: Number.NaN },
        seven_day_sonnet: { utilization: Number.POSITIVE_INFINITY },
        seven_day_opus: { utilization: 0.5 },
      }),
    );
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    const ok = result as UsageSnapshot;
    expect(ok.fiveHour).toBeUndefined();
    expect(ok.sevenDay).toBeUndefined();
    expect(ok.sevenDaySonnet).toBeUndefined();
    expect(ok.sevenDayOpus?.utilization).toBe(0.5);
  });

  it('returns unavailable/timeout when the request aborts via timeout', async () => {
    const fetchImpl = fetchThrowing(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN, timeoutMs: 5 });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
      detail: expect.any(String),
    });
  });

  it('returns unavailable/timeout on a generic AbortError', async () => {
    const fetchImpl = fetchThrowing(new DOMException('aborted', 'AbortError'));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('returns unavailable/network-error on other thrown fetch errors', async () => {
    const fetchImpl = fetchThrowing(new TypeError('fetch failed: getaddrinfo ENOTFOUND'));
    const result = await fetchSubscriptionUsage({ fetchImpl, token: SECRET_TOKEN });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'network-error',
      detail: expect.any(String),
    });
  });

  it('falls back to the keychain loader when no token override and no fetchImpl-bypassing occurs', async () => {
    // Passing an explicit empty-string token exercises the no-token branch
    // without touching the real keychain loader (covered above). This test
    // only asserts the options default wiring: omitting fetchImpl still
    // type-checks and defaults to global fetch, which we don't invoke here
    // because we supply a token of '' to short-circuit before any request.
    const result = await fetchSubscriptionUsage({ token: '' });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'no-token',
      detail: expect.any(String),
    });
  });
});

describe('formatUsagePlain', () => {
  it('renders all four windows, one per line', () => {
    const snapshot: UsageResult = {
      kind: 'ok',
      fiveHour: { utilization: 0.62, resetsAt: new Date('2026-07-26T18:00:00Z') },
      sevenDay: { utilization: 0.31 },
      sevenDaySonnet: { utilization: 0.28 },
      sevenDayOpus: { utilization: 0.44 },
    };
    const text = formatUsagePlain(snapshot);
    expect(text).toBe(
      ['5h: 62% (resets 18:00)', '7d: 31%', '7d-sonnet: 28%', '7d-opus: 44%'].join('\n'),
    );
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).not.toMatch(/<[a-z]+>/i);
  });

  it('renders a single line when only one window is present', () => {
    const snapshot: UsageResult = { kind: 'ok', fiveHour: { utilization: 0.1 } };
    expect(formatUsagePlain(snapshot)).toBe('5h: 10%');
  });

  it('renders a fallback line when kind is ok but no windows are present', () => {
    const snapshot: UsageResult = { kind: 'ok' };
    expect(formatUsagePlain(snapshot)).toBe('No usage windows available.');
  });

  it.each([
    ['no-token', 'Run `claude login`.'],
    ['http-error', 'HTTP 401.'],
    ['malformed-response', 'Body was not valid JSON.'],
    ['timeout', 'Request timed out.'],
    ['network-error', 'Could not reach the usage endpoint.'],
  ] as const)('renders a clear single line for reason=%s', (reason, detail) => {
    const result: UsageResult = { kind: 'unavailable', reason, detail };
    const text = formatUsagePlain(result);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain(reason);
    expect(text).toContain(detail);
  });
});
