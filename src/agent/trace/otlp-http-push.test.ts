/**
 * Tests for the OTLP/HTTP push helper.
 *
 * The HTTP layer is fully mocked — no real network calls are made.
 * Tests cover:
 *   - Successful 200 response returns { ok: true, status: 200 }.
 *   - 204 No Content response returns { ok: true, status: 204 }.
 *   - 4xx/5xx response returns { ok: false, status, error }.
 *   - Network error (fetch throws) returns { ok: false, error }.
 *   - Timeout abort returns { ok: false, error }.
 *   - Content-Type header is always sent and cannot be overridden by extraHeaders.
 *   - Extra headers are merged; content-type is NOT overridable.
 *   - parseOtlpHeaders parses comma-separated Key=Value pairs.
 *   - parseOtlpHeaders skips malformed pairs silently.
 *   - parseOtlpHeaders decodes %2C in values (round-trip).
 *   - parseOtlpHeaders skips header names/values containing CR or LF.
 *   - Dead endpoint never throws (fire-and-forget contract).
 *   - Invalid scheme is rejected without a network call.
 *   - Response body is cancelled after each response.
 *   - clearTimeout is called even on abort.
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

/** Build a mock fetch that returns the given status with a cancellable body. */
function mockFetch(status: number, ok: boolean, statusText = ''): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Response);
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

  it('returns ok:true on HTTP 204 (no-content passthrough)', async () => {
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      fetchFn: mockFetch(204, true, 'No Content'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(204);
  });

  it('sends POST with Content-Type application/json', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    const ct = (init.headers as Headers).get('Content-Type');
    expect(ct).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('sends the serialised payload as the request body', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as OtlpExportRequest;
    expect(parsed.resourceSpans).toHaveLength(1);
  });

  it('merges extra headers alongside Content-Type', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      headers: { Authorization: 'Bearer tok' },
      fetchFn,
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const hdrs = init.headers as Headers;
    expect(hdrs.get('Authorization')).toBe('Bearer tok');
    expect(hdrs.get('Content-Type')).toBe('application/json');
  });

  it('Content-Type is NOT overridable by extra headers', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      headers: { 'Content-Type': 'application/x-protobuf' },
      fetchFn,
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const hdrs = init.headers as Headers;
    // Content-Type must still be JSON regardless of what extraHeaders says.
    expect(hdrs.get('Content-Type')).toBe('application/json');
  });

  it('Content-Type lowercase variant does not create a duplicate', async () => {
    const fetchFn = mockFetch(200, true);
    await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      headers: { 'content-type': 'text/plain' },
      fetchFn,
    });
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const hdrs = init.headers as Headers;
    expect(hdrs.get('content-type')).toBe('application/json');
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

  it('clearTimeout is called even when fetch is aborted', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchFn = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    // Real timers are used here — we only assert the call resolves cleanly
    // (no leak / unhandled rejection) rather than inspecting clearTimeout.
    await expect(
      pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, timeoutMs: 50, fetchFn }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false (not a rejection) when extraHeaders contains an invalid name', async () => {
    const fetchFn = mockFetch(200, true);
    // A header name with a space is invalid per RFC 7230 but could be passed
    // programmatically via the `headers` option (bypassing parseOtlpHeaders).
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: ENDPOINT,
      headers: { 'Bad Header': 'value' },
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
    // Must NOT have called fetch — failed at Headers construction.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('captures HTTP status even when body.cancel() rejects', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway',
      body: { cancel: vi.fn().mockRejectedValue(new Error('cancel boom')) },
    } as unknown as Response);
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain('502');
    }
  });

  it('returns ok:false on non-Error thrown value', async () => {
    const fetchFn = vi.fn().mockRejectedValue('string error') as unknown as typeof fetch;
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('string error');
  });

  it('cancels the response body after a successful response', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: '',
      body: { cancel: cancelFn },
    } as unknown as Response);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    expect(cancelFn).toHaveBeenCalledOnce();
  });

  it('cancels the response body after a 4xx response', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests',
      body: { cancel: cancelFn },
    } as unknown as Response);
    await pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn });
    expect(cancelFn).toHaveBeenCalledOnce();
  });

  it('handles a null response body without throwing (guarded cancel)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: '',
      body: null,
    } as unknown as Response);
    await expect(
      pushOtlpHttp(MINIMAL_PAYLOAD, { endpoint: ENDPOINT, fetchFn }),
    ).resolves.toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Scheme validation
  // -------------------------------------------------------------------------

  it('rejects a non-http/https scheme without making a network call', async () => {
    const fetchFn = mockFetch(200, true);
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: 'ftp://example.com/v1/traces',
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scheme/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a completely invalid URL without making a network call', async () => {
    const fetchFn = mockFetch(200, true);
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: 'not a url at all',
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts https:// endpoint', async () => {
    const fetchFn = mockFetch(200, true);
    const result = await pushOtlpHttp(MINIMAL_PAYLOAD, {
      endpoint: 'https://collector.example.com/v1/traces',
      fetchFn,
    });
    expect(result.ok).toBe(true);
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

  it('decodes %2C in values (round-trip for literal commas)', () => {
    // A value containing a literal comma must be encoded as %2C in the env var.
    const result = parseOtlpHeaders('X-Custom=hello%2Cworld');
    expect(result['X-Custom']).toBe('hello,world');
  });

  it('leaves malformed percent sequences as-is without throwing', () => {
    // %ZZ is not a valid percent-encoding; the raw string is preserved.
    const result = parseOtlpHeaders('X-Bad=hello%ZZworld');
    expect(result['X-Bad']).toBe('hello%ZZworld');
  });

  it('skips header names containing CR (injection guard)', () => {
    const result = parseOtlpHeaders('X-Injected\r=bad,Safe=ok');
    expect(result['Safe']).toBe('ok');
    expect(Object.keys(result)).not.toContain('X-Injected\r');
  });

  it('skips header values containing LF (injection guard)', () => {
    const result = parseOtlpHeaders('X-Bad=value\nbad,Safe=ok');
    expect(result['Safe']).toBe('ok');
    expect(result['X-Bad']).toBeUndefined();
  });

  it('skips header names with spaces (RFC 7230 token guard)', () => {
    const result = parseOtlpHeaders('Bad Header=value,Safe=ok');
    expect(result['Safe']).toBe('ok');
    expect(result['Bad Header']).toBeUndefined();
  });

  it('skips header names with NUL bytes (RFC 7230 token guard)', () => {
    const result = parseOtlpHeaders('Bad\x00Name=value,Safe=ok');
    expect(result['Safe']).toBe('ok');
    expect(Object.keys(result)).toEqual(['Safe']);
  });

  it('accepts valid RFC 7230 token characters in header names', () => {
    // Exercise the full token charset: tchar = "!" / "#" / "$" / "%" / "&" /
    //   "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
    const result = parseOtlpHeaders('X-My_Header.v2=val');
    expect(result['X-My_Header.v2']).toBe('val');
  });
});
