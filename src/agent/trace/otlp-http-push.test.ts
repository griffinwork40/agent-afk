/**
 * Tests for the OTLP/HTTP push helper.
 *
 * The HTTP layer is fully mocked — no real network calls are made.
 * Tests cover:
 *   - Successful 200 response returns { ok: true, status: 200 }.
 *   - 4xx/5xx response returns { ok: false, status, error }.
 *   - Network error (fetch throws) returns { ok: false, error }.
 *   - Timeout abort returns { ok: false, error }.
 *   - Content-Type header is always sent.
 *   - Extra headers are merged and caller headers win on collision.
 *   - parseOtlpHeaders parses comma-separated Key=Value pairs.
 *   - parseOtlpHeaders skips malformed pairs silently.
 *   - Dead endpoint never throws (fire-and-forget contract).
 *
 * @module agent/trace/otlp-http-push.test
 */

import { describe, it, expect, vi } from 'vitest';
import { pushOtlpHttp, parseOtlpHeaders } from './otlp-http-push.js';
import type { OtlpExportRequest } from './otlp-export.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MINIMAL_PAYLOAD: OtlpExportRequest = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent-afk' } }] },
    scopeSpans: [{
      scope: { name: 'agent-afk.witness', version: '0.1.0' },
      spans: [{
        traceId: 'abcdef1234567890abcdef1234567890',
        spanId: 'a1b2c3d4e5f60718',
        name: 'afk.session',
        kind: 1,
        startTimeUnixNano: '1000000000000',
        endTimeUnixNano: '2000000000000',
        attributes: [],
        status: { code: 1 },
      }],
    }],
  }],
};

const ENDPOINT = 'http://localhost:4318/v1/traces';

/** Build a mock fetch that returns the given status. */
function mockFetch(status: number, ok: boolean, statusText = ''): typeof fetch {
  return vi.fn().mockResolvedValue({ ok, status, statusText } as Response);
}

/** Build a mock fetch that throws a network error. */
function mockFetchThrows(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// pushOtlpHttp
// ---------------------------------------------------------------------------

describe('pushOtlpHttp', () => {
  it('returns ok:true on HTTP 200', async () => {
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      fetchFn: mockFetch(200, true),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(200);
  });

  it('sends POST with Content-Type application/json', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('sends the serialised payload as the request body', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as OtlpExportRequest;
    expect(parsed.resourceSpans).toHaveLength(1);
  });

  it('merges extra headers and caller headers win on collision', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/x-protobuf' },
      fetchFn,
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs['Authorization']).toBe('Bearer tok');
    // caller wins on collision
    expect(hdrs['Content-Type']).toBe('application/x-protobuf');
  });

  it('returns ok:false with status on 4xx response', async () => {
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      fetchFn: mockFetch(400, false, 'Bad Request'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('400');
    }
  });

  it('returns ok:false with status on 5xx response', async () => {
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      fetchFn: mockFetch(503, false, 'Service Unavailable'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('returns ok:false on network error (fetch throws)', async () => {
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      fetchFn: mockFetchThrows('ECONNREFUSED'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ECONNREFUSED');
  });

  it('does not throw on network error (fire-and-forget contract)', async () => {
    await expect(
      pushOtlpHttp(MINIMAL_PAYLOAD, {
        endpoint: ENDPOINT,
        fetchFn: mockFetchThrows('network down'),
      }),
    ).resolves.not.toThrow();
  });

  it('returns ok:false when fetch is aborted (timeout)', async () => {
    // Simulate an AbortError, which is what AbortController fires.
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchFn = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      timeoutMs: 1,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/abort/i);
  });

  it('returns ok:false on non-Error thrown value', async () => {
    const fetchFn = vi.fn().mockRejectedValue('string error') as unknown as typeof fetch;
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// parseOtlpHeaders
// ---------------------------------------------------------------------------

describe('parseOtlpHeaders', () => {
  it('parses a single Key=Value pair', () => {
    expect(parseOtlpHeaders('Authorization=Bearer tok')).toEqual({
      Authorization: 'Bearer tok',
    });
  });

  it('parses multiple comma-separated pairs', () => {
    expect(parseOtlpHeaders('Authorization=Bearer tok,X-Org=acme')).toEqual({
      Authorization: 'Bearer tok',
      'X-Org': 'acme',
    });
  });

  it('handles values containing = signs', () => {
    const result = parseOtlpHeaders('X-Token=abc=def=ghi');
    expect(result['X-Token']).toBe('abc=def=ghi');
  });

  it('trims whitespace around key and value', () => {
    expect(parseOtlpHeaders(' Authorization = Bearer tok ')).toEqual({
      Authorization: 'Bearer tok',
    });
  });

  it('silently skips malformed pairs with no =', () => {
    expect(parseOtlpHeaders('badpair,Authorization=Bearer tok')).toEqual({
      Authorization: 'Bearer tok',
    });
  });

  it('silently skips pairs with empty key', () => {
    expect(parseOtlpHeaders('=value,Authorization=ok')).toEqual({
      Authorization: 'ok',
    });
  });

  it('returns empty object for empty string', () => {
    expect(parseOtlpHeaders('')).toEqual({});
  });
});
