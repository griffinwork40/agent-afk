/**
 * Unit tests for oauth-device.ts (startDeviceCodeFlow + pollDeviceCodeToken).
 *
 * Pins the exact error message strings and DevicePollResult semantics that
 * the prior inline POST blocks produced, now preserved via rawPostOAuthForm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startDeviceCodeFlow, pollDeviceCodeToken } from './oauth-device.js';
import type { XaiOidcDiscovery } from './oauth-http.js';
import { clearOidcCache } from './oauth-http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISCOVERY: XaiOidcDiscovery = {
  issuer: 'https://auth.x.ai',
  authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
  device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/auth',
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textRes(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** fetch stub: returns discovery first, then the provided response for the next call. */
function discoveryThenFetch(nextRes: Response): typeof fetch {
  let called = false;
  return vi.fn(async (_url: RequestInfo) => {
    if (!called) { called = true; return jsonRes(DISCOVERY); }
    return nextRes;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// startDeviceCodeFlow — happy path
// ---------------------------------------------------------------------------

describe('startDeviceCodeFlow — happy path', () => {
  beforeEach(() => { clearOidcCache(); });
  it('returns device fields from server response', async () => {
    const fetchFn = discoveryThenFetch(jsonRes({
      device_code: 'dc-1',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.x.ai/device',
      expires_in: 600,
      interval: 5,
    }));
    const { device } = await startDeviceCodeFlow({ fetchFn, issuer: 'https://auth.x.ai' });
    expect(device.device_code).toBe('dc-1');
    expect(device.user_code).toBe('ABCD-EFGH');
    expect(device.verification_uri).toBe('https://auth.x.ai/device');
    expect(device.expires_in).toBe(600);
    expect(device.interval).toBe(5);
  });

  it('includes verification_uri_complete when present', async () => {
    const fetchFn = discoveryThenFetch(jsonRes({
      device_code: 'dc-2',
      user_code: 'CODE',
      verification_uri: 'https://auth.x.ai/device',
      verification_uri_complete: 'https://auth.x.ai/device?user_code=CODE',
      expires_in: 300,
      interval: 5,
    }));
    const { device } = await startDeviceCodeFlow({ fetchFn, issuer: 'https://auth.x.ai' });
    expect(device.verification_uri_complete).toBe('https://auth.x.ai/device?user_code=CODE');
  });
});

// ---------------------------------------------------------------------------
// startDeviceCodeFlow — error message format (pinned)
// ---------------------------------------------------------------------------

describe('startDeviceCodeFlow — error message format', () => {
  beforeEach(() => { clearOidcCache(); });
  it('throws "xAI device-code start failed: HTTP <N> — <text>" when body is plain text', async () => {
    const fetchFn = discoveryThenFetch(textRes('Service Unavailable', 503));
    await expect(
      startDeviceCodeFlow({ fetchFn, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('xAI device-code start failed: HTTP 503 — Service Unavailable');
  });

  it('throws "xAI device-code start failed: HTTP <N>" with no dash when body is empty', async () => {
    const fetchFn = discoveryThenFetch(new Response('', { status: 400 }));
    await expect(
      startDeviceCodeFlow({ fetchFn, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('xAI device-code start failed: HTTP 400');
    // Must NOT contain " — " suffix when text is empty
    await expect(
      startDeviceCodeFlow({ fetchFn: discoveryThenFetch(new Response('', { status: 400 })), issuer: 'https://auth.x.ai' }),
    ).rejects.not.toThrow(' — ');
  });

  it('throws on missing required fields', async () => {
    const fetchFn = discoveryThenFetch(jsonRes({ device_code: 'dc' })); // missing user_code + verification_uri
    await expect(
      startDeviceCodeFlow({ fetchFn, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('xAI device-code response missing device_code, user_code, or verification_uri');
  });
});

// ---------------------------------------------------------------------------
// pollDeviceCodeToken — DevicePollResult semantics (pinned)
// ---------------------------------------------------------------------------

describe('pollDeviceCodeToken — poll result semantics', () => {
  it('returns { status: "pending" } for authorization_pending', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'authorization_pending' }, 400)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'pending' });
  });

  it('returns { status: "slow_down", interval } for slow_down', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'slow_down', interval: 10 }, 400)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'slow_down', interval: 10 });
  });

  it('slow_down falls back to 5s default when interval is missing', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'slow_down' }, 400)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'slow_down', interval: 5 });
  });

  it('returns { status: "expired" } for expired_token', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'expired_token' }, 400)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'expired' });
  });

  it('returns { status: "denied" } for access_denied', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'access_denied' }, 400)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'denied' });
  });

  it('returns { status: "error", message: "<err>: <desc>" } for unknown error with description', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ error: 'server_error', error_description: 'Internal failure' }, 500),
    ) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'error', message: 'server_error: Internal failure' });
  });

  it('returns { status: "error", message: "<err>" } for unknown error without description', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: 'server_error' }, 500)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'error', message: 'server_error' });
  });

  it('returns { status: "error", message: "http_<N>" } when no error field', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 503)) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'error', message: 'http_503' });
  });

  it('returns { status: "success", tokens } on ok response', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    ) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn, nowSeconds: () => 1000 });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.tokens.access_token).toBe('at-1');
      expect(r.tokens.refresh_token).toBe('rt-1');
      expect(r.tokens.expires_at).toBe(1000 + 3600);
    }
  });

  it('returns error when ok but token response missing fields', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ access_token: 'at-only' })) as unknown as typeof fetch;
    const r = await pollDeviceCodeToken(DISCOVERY, 'dc-1', { fetchFn });
    expect(r).toEqual({ status: 'error', message: 'token response missing access_token or refresh_token' });
  });
});

// ---------------------------------------------------------------------------
// rawPostOAuthForm integration — postOAuthForm still works (regression)
// ---------------------------------------------------------------------------

describe('postOAuthForm still throws on non-ok (regression via rawPostOAuthForm)', () => {
  it('postOAuthForm throws with correct prefix', async () => {
    const { postOAuthForm } = await import('./oauth-http.js');
    const fetchFn = vi.fn(async () => jsonRes({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(
      postOAuthForm('https://auth.x.ai/oauth2/token', { grant_type: 'refresh_token' }, 'xAI token refresh failed', fetchFn),
    ).rejects.toThrow('xAI token refresh failed: invalid_grant');
  });
});
