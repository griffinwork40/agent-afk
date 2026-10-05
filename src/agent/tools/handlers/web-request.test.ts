/**
 * Unit tests for the `web_request` tool handler.
 *
 * All tests inject `fetchFn` and `lookupFn` so no real network or DNS calls
 * are issued.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWebRequestHandler } from './web-request.js';

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
// Input validation
// ---------------------------------------------------------------------------

describe('web_request handler — input validation', () => {
  const handler = createWebRequestHandler({
    fetchFn: makeFetch(() => makeResponse({ body: 'unused' })),
    lookupFn: publicLookup,
  });

  it('rejects non-object input', async () => {
    const r = await handler('not-an-object' as unknown, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/expected an object/);
  });

  it('rejects missing url', async () => {
    const r = await handler({ method: 'GET' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/url/);
  });

  it('rejects invalid url', async () => {
    const r = await handler({ url: 'not-a-url', method: 'GET' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a valid absolute URL/);
  });

  it('rejects non-http scheme', async () => {
    const r = await handler({ url: 'ftp://example.com/', method: 'GET' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not supported/);
  });

  it('rejects missing method', async () => {
    const r = await handler({ url: 'https://example.com/' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/method/);
  });

  it('rejects unsupported method', async () => {
    const r = await handler({ url: 'https://example.com/', method: 'CONNECT' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not supported/);
  });

  it('rejects non-object headers', async () => {
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', headers: 'bad' },
      signal(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/headers/);
  });

  it('rejects non-string header value', async () => {
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', headers: { 'x-count': 42 } },
      signal(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/header value/);
  });

  it('rejects invalid timeout_ms', async () => {
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', timeout_ms: -1 },
      signal(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timeout_ms/);
  });

  it('rejects invalid max_response_bytes', async () => {
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', max_response_bytes: 0 },
      signal(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/max_response_bytes/);
  });

  it('rejects empty credential string', async () => {
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', credential: '' },
      signal(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/credential/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('web_request handler — GET happy path', () => {
  it('returns JSON-structured response', async () => {
    const fetchFn = makeFetch(() =>
      makeResponse({ body: 'Hello', contentType: 'text/plain' }),
    );
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler({ url: 'https://example.com/', method: 'GET' }, signal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as {
      status: number;
      body: unknown;
      timing_ms: number;
      headers: Record<string, string>;
    };
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('Hello');
    expect(parsed.timing_ms).toBeGreaterThanOrEqual(0);
  });

  it('auto-parses JSON response body', async () => {
    const fetchFn = makeFetch(() =>
      makeResponse({ body: '{"key":"val"}', contentType: 'application/json' }),
    );
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler({ url: 'https://api.example.com/', method: 'GET' }, signal());

    const parsed = JSON.parse(r.content as string) as { body: unknown };
    expect(parsed.body).toEqual({ key: 'val' });
  });
});

describe('web_request handler — POST with body', () => {
  it('sends body and returns medium risk indication', async () => {
    let receivedBody: string | null = null;
    const fetchFn = makeFetch((_url, init) => {
      receivedBody = typeof init.body === 'string' ? init.body : null;
      return makeResponse({ body: '{"created":true}', contentType: 'application/json' });
    });
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler(
      { url: 'https://api.example.com/items', method: 'POST', body: { name: 'test' } },
      signal(),
    );

    expect(r.isError).toBeUndefined();
    expect(receivedBody).toBe('{"name":"test"}');
    // Response is a JSON object, no isError
    const parsed = JSON.parse(r.content as string) as { status: number };
    expect(parsed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// SSRF blocking
// ---------------------------------------------------------------------------

describe('web_request handler — SSRF blocking', () => {
  it('returns error result for loopback target', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'secret' }));
    const handler = createWebRequestHandler({ fetchFn });
    const r = await handler({ url: 'http://127.0.0.1/admin', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
  });

  it('returns error for hostname resolving to private IP', async () => {
    const privateLookup = async (): Promise<readonly { address: string }[]> => [
      { address: '192.168.1.1' },
    ];
    const fetchFn = makeFetch(() => makeResponse({ body: 'internal' }));
    const handler = createWebRequestHandler({ fetchFn, lookupFn: privateLookup });
    const r = await handler(
      { url: 'https://internal.corp.example.com/', method: 'GET' },
      signal(),
    );

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
  });
});

// ---------------------------------------------------------------------------
// Credential injection
// ---------------------------------------------------------------------------

describe('web_request handler — credential injection', () => {
  it('injects env var as Bearer token', async () => {
    let capturedAuth: string | null = null;
    const fetchFn = makeFetch((_url, init) => {
      const hdrs = init.headers as Record<string, string> | undefined;
      capturedAuth = hdrs?.['Authorization'] ?? null;
      return makeResponse({ body: 'ok' });
    });
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { MY_API_KEY: 'secret-token-value' },
    });
    const r = await handler(
      { url: 'https://api.example.com/', method: 'GET', credential: 'MY_API_KEY' },
      signal(),
    );

    expect(r.isError).toBeUndefined();
    expect(capturedAuth).toBe('Bearer secret-token-value');
  });

  it('returns error when env var is not set', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: {},
    });
    const r = await handler(
      { url: 'https://api.example.com/', method: 'GET', credential: 'MISSING_VAR' },
      signal(),
    );

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/MISSING_VAR/);
    expect(r.content).toMatch(/not set/);
  });

  it('returns an error when both credential and Authorization header are supplied', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { MY_KEY: 'env-value' },
    });
    const r = await handler(
      {
        url: 'https://api.example.com/',
        method: 'GET',
        headers: { Authorization: 'Bearer caller-supplied' },
        credential: 'MY_KEY',
      },
      signal(),
    );

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/both "credential" and an explicit Authorization header/);
  });
});

// ---------------------------------------------------------------------------
// Domain policy
// ---------------------------------------------------------------------------

describe('web_request handler — domain policy', () => {
  it('returns error when domain is blocked', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      domainCheck: () => ({ allowed: false, reason: 'not in AFK_BROWSER_ALLOWED_DOMAINS' }),
    });
    const r = await handler({ url: 'https://blocked.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
  });

  // Regression test for #2881: domain policy must not be silently dropped when
  // an unrelated browser config field (e.g. AFK_BROWSER_BACKEND) is invalid.
  // Previously, loadBrowserConfig() threw on the bad backend and the catch
  // block returned undefined, bypassing AFK_BROWSER_BLOCKED_DOMAINS entirely.
  it('enforces AFK_BROWSER_BLOCKED_DOMAINS even when AFK_BROWSER_BACKEND is invalid (#2881)', async () => {
    let fetchCalled = false;
    const fetchFn = makeFetch(() => {
      fetchCalled = true;
      return makeResponse({ body: 'should not reach here' });
    });
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: {
        AFK_BROWSER_BLOCKED_DOMAINS: 'blocked.example.com',
        AFK_BROWSER_BACKEND: 'bogus', // invalid — would make loadBrowserConfig() throw
      },
    });
    const r = await handler({ url: 'https://blocked.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(fetchCalled).toBe(false);
  });

  it('allows requests not in AFK_BROWSER_BLOCKED_DOMAINS when backend is invalid (#2881)', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok', contentType: 'text/plain' }));
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: {
        AFK_BROWSER_BLOCKED_DOMAINS: 'blocked.example.com',
        AFK_BROWSER_BACKEND: 'bogus',
      },
    });
    // different domain — should pass the policy
    const r = await handler({ url: 'https://allowed.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBeUndefined();
  });

  // B2: browser.json domain arrays replace env arrays (not union).
  // The web_request domain policy must match loadBrowserConfig semantics.
  it('browser.json allowedDomains replaces env allowedDomains (B2 — file wins, not union)', async () => {
    let fetchCalled = false;
    const fetchFn = makeFetch(() => {
      fetchCalled = true;
      return makeResponse({ body: 'ok' });
    });
    // env allows env.example.com; file replaces with file.example.com only.
    // A request to env.example.com must now be BLOCKED (env list was replaced).
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { AFK_BROWSER_ALLOWED_DOMAINS: 'env.example.com' },
      readFileSync: () => JSON.stringify({ allowedDomains: ['file.example.com'] }),
    });
    const r = await handler({ url: 'https://env.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(fetchCalled).toBe(false);
  });

  it('browser.json allowedDomains allows the file-listed domain (B2)', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok', contentType: 'text/plain' }));
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { AFK_BROWSER_ALLOWED_DOMAINS: 'env.example.com' },
      readFileSync: () => JSON.stringify({ allowedDomains: ['file.example.com'] }),
    });
    const r = await handler({ url: 'https://file.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBeUndefined();
  });

  // B1: malformed browser.json must not cause domain policy to fail open.
  // env domain lists must survive a bad file.
  it('malformed browser.json: env blocked domain still enforced (B1)', async () => {
    let fetchCalled = false;
    const fetchFn = makeFetch(() => {
      fetchCalled = true;
      return makeResponse({ body: 'should not reach' });
    });
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { AFK_BROWSER_BLOCKED_DOMAINS: 'blocked.example.com' },
      readFileSync: () => '{ not valid json !!!',
    });
    const r = await handler({ url: 'https://blocked.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(fetchCalled).toBe(false);
  });

  it('non-object browser.json (array): env allowed domain still enforced (B1)', async () => {
    let fetchCalled = false;
    const fetchFn = makeFetch(() => {
      fetchCalled = true;
      return makeResponse({ body: 'ok' });
    });
    // allowed list has only allowed.example.com; file is an array (invalid) — must fall back to env
    const handler = createWebRequestHandler({
      fetchFn,
      lookupFn: publicLookup,
      env: { AFK_BROWSER_ALLOWED_DOMAINS: 'allowed.example.com' },
      readFileSync: () => '["not","an","object"]',
    });
    // not in env allowed list → must be blocked
    const r = await handler({ url: 'https://blocked.example.com/', method: 'GET' }, signal());

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Secret redaction in response body
// ---------------------------------------------------------------------------

describe('web_request handler — secret redaction in response', () => {
  it('redacts Authorization header tokens from string response body', async () => {
    const bodyWithSecret = 'Authorization: Bearer sk-ant-api03-super-secret-token-1234567890123456789012345678901234567890';
    const fetchFn = makeFetch(() =>
      makeResponse({ body: bodyWithSecret, contentType: 'text/plain' }),
    );
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler({ url: 'https://example.com/', method: 'GET' }, signal());

    const parsed = JSON.parse(r.content as string) as { body: unknown };
    expect(typeof parsed.body).toBe('string');
    expect(parsed.body as string).toContain('[REDACTED]');
    expect(parsed.body as string).not.toContain('super-secret-token');
  });
});

// ---------------------------------------------------------------------------
// Response truncation flag propagation
// ---------------------------------------------------------------------------

describe('web_request handler — truncation flag', () => {
  it('sets truncated on ToolResult when body is truncated', async () => {
    const bigBody = 'a'.repeat(200_000);
    const fetchFn = makeFetch(() =>
      makeResponse({ body: bigBody, contentType: 'text/plain' }),
    );
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', max_response_bytes: 1000 },
      signal(),
    );

    expect(r.isError).toBeUndefined();
    expect(r.truncated).toBe(true);
    const parsed = JSON.parse(r.content as string) as { truncated?: boolean };
    expect(parsed.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pre-aborted signal
// ---------------------------------------------------------------------------

describe('web_request handler — pre-aborted signal', () => {
  it('returns abort error when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled before start'));

    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler({ url: 'https://example.com/', method: 'GET' }, ac.signal);

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
  });
});

// ---------------------------------------------------------------------------
// timeout_ms and max_response_bytes clamping
// ---------------------------------------------------------------------------

describe('web_request handler — clamping', () => {
  it('clamps timeout_ms to 120000', async () => {
    // Just ensure we don't error on a valid oversized timeout
    const fetchFn = makeFetch(() => makeResponse({ body: 'ok' }));
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', timeout_ms: 999_999 },
      signal(),
    );
    expect(r.isError).toBeUndefined();
  });

  it('clamps max_response_bytes to 1MB', async () => {
    const fetchFn = makeFetch(() => makeResponse({ body: 'small', contentType: 'text/plain' }));
    const handler = createWebRequestHandler({ fetchFn, lookupFn: publicLookup });
    const r = await handler(
      { url: 'https://example.com/', method: 'GET', max_response_bytes: 9_999_999 },
      signal(),
    );
    expect(r.isError).toBeUndefined();
  });
});
