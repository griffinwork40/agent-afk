/**
 * Unit tests for postOAuthForm (oauth-http.ts).
 *
 * Covers: correct headers/method/body encoding, tolerant JSON decode on error,
 * error message formatting (error + error_description combinations), and
 * http_<status> fallback when the body carries no `error` field.
 */

import { describe, expect, it, vi } from 'vitest';
import { postOAuthForm } from './oauth-http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(opts: {
  status: number;
  body?: unknown;
  jsonThrows?: boolean;
}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    json: opts.jsonThrows
      ? () => Promise.reject(new SyntaxError('bad json'))
      : () => Promise.resolve(opts.body ?? {}),
  }) as unknown as typeof fetch;
}

const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const PARAMS = { grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid' };

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('postOAuthForm — happy path', () => {
  it('sends POST with correct headers and URL-encoded body', async () => {
    const fetchFn = makeFetch({ status: 200, body: { access_token: 'at', refresh_token: 'rt2' } });
    await postOAuthForm(TOKEN_URL, PARAMS, 'prefix', fetchFn);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
    // Body must be URL-encoded string
    expect(init.body).toBe(new URLSearchParams(PARAMS).toString());
  });

  it('returns the parsed JSON body on success', async () => {
    const responseBody = { access_token: 'at', refresh_token: 'rt2', expires_in: 3600 };
    const fetchFn = makeFetch({ status: 200, body: responseBody });
    const result = await postOAuthForm(TOKEN_URL, PARAMS, 'prefix', fetchFn);
    expect(result).toEqual(responseBody);
  });
});

// ---------------------------------------------------------------------------
// Error message formatting
// ---------------------------------------------------------------------------

describe('postOAuthForm — error message formatting', () => {
  it('throws "<prefix>: <err>" when body has error but no description', async () => {
    const fetchFn = makeFetch({ status: 400, body: { error: 'invalid_grant' } });
    await expect(postOAuthForm(TOKEN_URL, PARAMS, 'xAI token refresh failed', fetchFn)).rejects.toThrow(
      'xAI token refresh failed: invalid_grant',
    );
  });

  it('throws "<prefix>: <err>: <desc>" when body has both error and error_description', async () => {
    const fetchFn = makeFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been revoked' },
    });
    await expect(postOAuthForm(TOKEN_URL, PARAMS, 'xAI token refresh failed', fetchFn)).rejects.toThrow(
      'xAI token refresh failed: invalid_grant: Token has been revoked',
    );
  });

  it('falls back to http_<status> when body has no error field', async () => {
    const fetchFn = makeFetch({ status: 503, body: {} });
    await expect(postOAuthForm(TOKEN_URL, PARAMS, 'xAI token refresh failed', fetchFn)).rejects.toThrow(
      'xAI token refresh failed: http_503',
    );
  });

  it('uses different prefix correctly (authorization_code exchange)', async () => {
    const fetchFn = makeFetch({ status: 401, body: { error: 'access_denied' } });
    await expect(
      postOAuthForm(TOKEN_URL, PARAMS, 'xAI authorization_code exchange failed', fetchFn),
    ).rejects.toThrow('xAI authorization_code exchange failed: access_denied');
  });
});

// ---------------------------------------------------------------------------
// Tolerant JSON decode
// ---------------------------------------------------------------------------

describe('postOAuthForm — tolerant JSON decode', () => {
  it('resolves to {} when response body is not valid JSON (non-ok)', async () => {
    const fetchFn = makeFetch({ status: 500, jsonThrows: true });
    // Should fall back to http_500 (no error field in the empty object)
    await expect(postOAuthForm(TOKEN_URL, PARAMS, 'prefix', fetchFn)).rejects.toThrow(
      'prefix: http_500',
    );
  });

  it('resolves to {} when response body is not valid JSON (ok status)', async () => {
    // Unusual but: a 200 with unparseable JSON should not throw from postOAuthForm itself;
    // the caller handles missing fields.
    const fetchFn = makeFetch({ status: 200, jsonThrows: true });
    const result = await postOAuthForm(TOKEN_URL, PARAMS, 'prefix', fetchFn);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Default fetch fallback (uses global fetch when none supplied)
// ---------------------------------------------------------------------------

describe('postOAuthForm — fetchFn defaulting', () => {
  it('uses the injected fetchFn when provided', async () => {
    const fetchFn = makeFetch({ status: 200, body: { access_token: 'x', refresh_token: 'y' } });
    await postOAuthForm(TOKEN_URL, PARAMS, 'p', fetchFn);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
