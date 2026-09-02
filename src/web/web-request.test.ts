/**
 * Unit tests for the `web_request` core implementation (src/web/web-request.ts).
 *
 * All tests use injected `fetchFn` and `lookupFn` so no real network or DNS
 * calls are issued.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  webRequest,
  parseMethod,
  classifyMethodRisk,
  isIdempotentMethod,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES,
  type HttpMethod,
} from './web-request.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;

/** Always resolves to a public IP — passes the SSRF guard without real DNS. */
const publicLookup = async (): Promise<readonly { address: string }[]> => [
  { address: '93.184.216.34' },
];

function makeResponse(init: {
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}): Response {
  const status = init.status ?? 200;
  const hdrs: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.contentType !== undefined) hdrs['content-type'] = init.contentType;
  return new Response(init.body ?? '', { status, headers: hdrs });
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchFn {
  return vi.fn(async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    return handler(url, init ?? {});
  }) as unknown as FetchFn;
}

const signal = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------
// parseMethod
// ---------------------------------------------------------------------------

describe('parseMethod', () => {
  const valid: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  for (const m of valid) {
    it(`accepts ${m}`, () => {
      expect(parseMethod(m)).toBe(m);
    });
    it(`accepts lowercase ${m.toLowerCase()}`, () => {
      expect(parseMethod(m.toLowerCase())).toBe(m);
    });
  }

  it('rejects unknown method', () => {
    const r = parseMethod('CONNECT');
    expect(r).toMatchObject({ error: expect.stringContaining('not supported') as unknown });
  });

  it('rejects empty string', () => {
    const r = parseMethod('');
    expect(r).toMatchObject({ error: expect.any(String) as unknown });
  });

  it('rejects non-string', () => {
    const r = parseMethod(42);
    expect(r).toMatchObject({ error: expect.any(String) as unknown });
  });
});

// ---------------------------------------------------------------------------
// classifyMethodRisk / isIdempotentMethod
// ---------------------------------------------------------------------------

describe('classifyMethodRisk', () => {
  it('GET → low', () => expect(classifyMethodRisk('GET')).toBe('low'));
  it('HEAD → low', () => expect(classifyMethodRisk('HEAD')).toBe('low'));
  it('OPTIONS → low', () => expect(classifyMethodRisk('OPTIONS')).toBe('low'));
  it('POST → medium', () => expect(classifyMethodRisk('POST')).toBe('medium'));
  it('PUT → medium', () => expect(classifyMethodRisk('PUT')).toBe('medium'));
  it('PATCH → medium', () => expect(classifyMethodRisk('PATCH')).toBe('medium'));
  it('DELETE → high', () => expect(classifyMethodRisk('DELETE')).toBe('high'));
});

describe('isIdempotentMethod', () => {
  it('GET → true', () => expect(isIdempotentMethod('GET')).toBe(true));
  it('HEAD → true', () => expect(isIdempotentMethod('HEAD')).toBe(true));
  it('OPTIONS → true', () => expect(isIdempotentMethod('OPTIONS')).toBe(true));
  it('PUT → true', () => expect(isIdempotentMethod('PUT')).toBe(true));
  it('DELETE → true', () => expect(isIdempotentMethod('DELETE')).toBe(true));
  it('POST → false', () => expect(isIdempotentMethod('POST')).toBe(false));
  it('PATCH → false', () => expect(isIdempotentMethod('PATCH')).toBe(false));
});

// ---------------------------------------------------------------------------
// webRequest — happy path
// ---------------------------------------------------------------------------

describe('webRequest — GET happy path', () => {
  it('returns status, body, timing, risk', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'Hello World', contentType: 'text/plain' }));
    const result = await webRequest({
      url: 'https://example.com/api',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('Hello World');
    expect(result.risk).toBe('low');
    expect(result.timing_ms).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBe(false);
  });

  it('auto-parses JSON when content-type is application/json', async () => {
    const data = { user: 'alice', score: 42 };
    const fetchFn = makeFetch(() =>
      makeResponse({ body: JSON.stringify(data), contentType: 'application/json' }),
    );
    const result = await webRequest({
      url: 'https://api.example.com/user',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.body).toEqual(data);
    expect(result.truncated).toBe(false);
  });

  it('returns string body when JSON parse fails', async () => {
    const fetchFn = makeFetch(() =>
      makeResponse({ body: 'not-valid-json{{{', contentType: 'application/json' }),
    );
    const result = await webRequest({
      url: 'https://api.example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(typeof result.body).toBe('string');
  });
});

describe('webRequest — POST with JSON body', () => {
  it('sends JSON body and returns medium risk', async () => {
    let capturedBody: string | null = null;
    let capturedContentType: string | null = null;

    const fetchFn = makeFetch((_url, init) => {
      capturedBody = typeof init.body === 'string' ? init.body : null;
      const hdrs = init.headers as Record<string, string> | undefined;
      capturedContentType = hdrs?.['content-type'] ?? null;
      return makeResponse({ body: '{"ok":true}', contentType: 'application/json' });
    });

    const result = await webRequest({
      url: 'https://api.example.com/data',
      method: 'POST',
      body: { name: 'test', value: 1 },
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });

    expect(result.status).toBe(200);
    expect(result.risk).toBe('medium');
    expect(capturedBody).toBe('{"name":"test","value":1}');
    expect(capturedContentType).toBe('application/json');
  });

  it('sends string body with text/plain content-type', async () => {
    let capturedContentType: string | null = null;
    const fetchFn = makeFetch((_url, init) => {
      const hdrs = init.headers as Record<string, string> | undefined;
      capturedContentType = hdrs?.['content-type'] ?? null;
      return makeResponse({ body: 'ok' });
    });

    await webRequest({
      url: 'https://api.example.com/plain',
      method: 'POST',
      body: 'raw text body',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(capturedContentType).toBe('text/plain');
  });

  it('respects caller-supplied content-type override', async () => {
    let capturedContentType: string | null = null;
    const fetchFn = makeFetch((_url, init) => {
      const hdrs = init.headers as Record<string, string> | undefined;
      capturedContentType = hdrs?.['content-type'] ?? null;
      return makeResponse({ body: 'ok' });
    });

    await webRequest({
      url: 'https://api.example.com/',
      method: 'POST',
      body: { foo: 'bar' },
      headers: { 'content-type': 'application/vnd.api+json' },
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(capturedContentType).toBe('application/vnd.api+json');
  });
});

describe('webRequest — DELETE risk', () => {
  it('returns high risk for DELETE', async () => {
    const fetchFn = makeFetch(() => makeResponse({ status: 200, body: '{"deleted":true}', contentType: 'application/json' }));
    const result = await webRequest({
      url: 'https://api.example.com/resource/1',
      method: 'DELETE',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.risk).toBe('high');
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Response truncation
// ---------------------------------------------------------------------------

describe('webRequest — response truncation', () => {
  it('truncates body when over maxResponseBytes', async () => {
    const bigBody = 'x'.repeat(200_000);
    const fetchFn = makeFetch(() =>
      makeResponse({ body: bigBody, contentType: 'text/plain' }),
    );
    const result = await webRequest({
      url: 'https://example.com/big',
      method: 'GET',
      maxResponseBytes: 1000,
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.truncated).toBe(true);
    expect(typeof result.body).toBe('string');
    expect(Buffer.byteLength(result.body as string, 'utf8')).toBeLessThanOrEqual(1500); // marker overhead
  });

  it('does not truncate when body fits', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'small', contentType: 'text/plain' }));
    const result = await webRequest({
      url: 'https://example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.truncated).toBe(false);
    expect(result.body).toBe('small');
  });

  it('enforces MAX_RESPONSE_BYTES ceiling', () => {
    // Just verify the constant is as documented
    expect(MAX_RESPONSE_BYTES).toBe(1_000_000);
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Response header filtering
// ---------------------------------------------------------------------------

describe('webRequest — response header filtering', () => {
  it('strips set-cookie headers', async () => {
    const fetchFn = makeFetch(() =>
      makeResponse({
        body: 'ok',
        headers: { 'set-cookie': 'session=abc; HttpOnly', 'content-type': 'text/plain' },
      }),
    );
    const result = await webRequest({
      url: 'https://example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(Object.keys(result.headers)).not.toContain('set-cookie');
    expect(result.headers['content-type']).toBe('text/plain');
  });

  it('strips x- headers', async () => {
    const fetchFn = makeFetch(() =>
      makeResponse({
        body: 'ok',
        headers: { 'x-request-id': '123', 'x-internal': 'secret', 'content-type': 'text/plain' },
      }),
    );
    const result = await webRequest({
      url: 'https://example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(Object.keys(result.headers)).not.toContain('x-request-id');
    expect(Object.keys(result.headers)).not.toContain('x-internal');
  });
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

describe('webRequest — SSRF guard', () => {
  it('blocks requests to loopback addresses', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'should not reach' }));
    await expect(
      webRequest({
        url: 'http://127.0.0.1/secret',
        method: 'GET',
        signal: signal(),
        fetchFn,
        // No lookupFn override — the IP literal path classifies without DNS
      }),
    ).rejects.toThrow(/internal\/private address/);
  });

  it('blocks requests to cloud metadata endpoint', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'metadata' }));
    await expect(
      webRequest({
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
        signal: signal(),
        fetchFn,
      }),
    ).rejects.toThrow(/internal\/private address/);
  });

  it('allows public addresses', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'public ok' }));
    const result = await webRequest({
      url: 'https://example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(result.status).toBe(200);
  });

  it('blocks hostname that resolves to private IP', async () => {
    const privateLookup = async (): Promise<readonly { address: string }[]> => [
      { address: '10.0.0.1' },
    ];
    const fetchFn = makeFetch(() => makeResponse({ body: 'private' }));
    await expect(
      webRequest({
        url: 'https://internal.example.com/secret',
        method: 'GET',
        signal: signal(),
        fetchFn,
        lookupFn: privateLookup,
      }),
    ).rejects.toThrow(/internal\/private address/);
  });
});

// ---------------------------------------------------------------------------
// Domain policy check
// ---------------------------------------------------------------------------

describe('webRequest — domain policy', () => {
  it('blocks when domainCheck returns not-allowed', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    await expect(
      webRequest({
        url: 'https://blocked.example.com/',
        method: 'GET',
        signal: signal(),
        fetchFn,
        lookupFn: publicLookup,
        domainCheck: () => ({ allowed: false, reason: 'not in allowlist' }),
      }),
    ).rejects.toThrow(/domain policy/);
  });

  it('allows when domainCheck returns allowed', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const result = await webRequest({
      url: 'https://allowed.example.com/',
      method: 'GET',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
      domainCheck: () => ({ allowed: true }),
    });
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Effect ledger hook
// ---------------------------------------------------------------------------

describe('webRequest — effect ledger hook', () => {
  it('calls recordEffect with correct metadata', async () => {
    const fetchFn = makeFetch(() => makeResponse({ status: 201, body: 'created' }));
    const calls: Array<{
      url: string;
      method: HttpMethod;
      status: number;
      risk: string;
      timing_ms: number;
    }> = [];

    await webRequest({
      url: 'https://api.example.com/items',
      method: 'POST',
      signal: signal(),
      fetchFn,
      lookupFn: publicLookup,
      recordEffect: (entry) => {
        calls.push(entry);
      },
    });

    // recordEffect is fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/items');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.status).toBe(201);
    expect(calls[0]?.risk).toBe('medium');
    expect(calls[0]?.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when recordEffect is absent', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    await expect(
      webRequest({
        url: 'https://example.com/',
        method: 'GET',
        signal: signal(),
        fetchFn,
        lookupFn: publicLookup,
      }),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('webRequest — constant defaults', () => {
  it('DEFAULT_TIMEOUT_MS is 30000', () => expect(DEFAULT_TIMEOUT_MS).toBe(30_000));
  it('DEFAULT_MAX_RESPONSE_BYTES is 100000', () => expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(100_000));
  it('MAX_RESPONSE_BYTES is 1000000', () => expect(MAX_RESPONSE_BYTES).toBe(1_000_000));
});
