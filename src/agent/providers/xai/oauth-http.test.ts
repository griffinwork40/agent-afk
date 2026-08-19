import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOidcCache, discoverXaiOidc, discoverXaiOidcCached, tokenResponseToBundle } from './oauth-http.js';

// ---------------------------------------------------------------------------
// tokenResponseToBundle
// ---------------------------------------------------------------------------
describe('tokenResponseToBundle', () => {
  const base = { access_token: 'at', refresh_token: 'rt' };
  const fixedNow = () => 1000;

  it('passes through a normal expires_in', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 3600 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 3600);
  });

  it('floors expires_in: 0 above the refresh skew', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 0 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('floors negative expires_in above the refresh skew', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: -500 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('floors expires_in below the refresh-safe minimum', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 30 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('allows expires_in at the ceiling (86400)', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 86400 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 86400);
  });

  it('caps expires_in above ceiling to 86400', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 999999 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 86400);
  });

  it('defaults to 3600 when expires_in is not a number', () => {
    const b = tokenResponseToBundle({ ...base }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 3600);
  });
});

// ---------------------------------------------------------------------------
// discoverXaiOidcCached
// ---------------------------------------------------------------------------
const DISCOVERY_BODY = {
  issuer: 'https://auth.x.ai',
  authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
};

function makeFetchFn(body = DISCOVERY_BODY, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('discoverXaiOidcCached', () => {
  beforeEach(() => {
    clearOidcCache();
  });

  it('fetches on first call and returns the discovery document', async () => {
    const fetchFn = makeFetchFn();
    const result = await discoverXaiOidcCached({
      fetchFn: fetchFn as unknown as typeof fetch,
      issuer: 'https://auth.x.ai',
    });
    expect(result.token_endpoint).toBe(DISCOVERY_BODY.token_endpoint);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second call without fetching again', async () => {
    const fetchFn = makeFetchFn();
    const deps = { fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' };
    const first = await discoverXaiOidcCached(deps);
    const second = await discoverXaiOidcCached(deps);
    expect(second).toBe(first); // same object reference
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires', async () => {
    const fetchFn = makeFetchFn();
    let now = 0;
    const nowMs = () => now;
    const deps = {
      fetchFn: fetchFn as unknown as typeof fetch,
      issuer: 'https://auth.x.ai',
      nowMs,
    };

    // First call at t=0
    await discoverXaiOidcCached(deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Advance just past the 24h TTL (24 * 3600 * 1000 ms)
    now = 24 * 60 * 60 * 1000 + 1;
    await discoverXaiOidcCached(deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-fetch while still within the TTL', async () => {
    const fetchFn = makeFetchFn();
    let now = 0;
    const nowMs = () => now;
    const deps = {
      fetchFn: fetchFn as unknown as typeof fetch,
      issuer: 'https://auth.x.ai',
      nowMs,
    };

    await discoverXaiOidcCached(deps);
    now = 23 * 60 * 60 * 1000; // 23 hours in — still valid
    await discoverXaiOidcCached(deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('clearOidcCache forces a fresh fetch', async () => {
    const fetchFn = makeFetchFn();
    const deps = { fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' };
    await discoverXaiOidcCached(deps);
    clearOidcCache();
    await discoverXaiOidcCached(deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// RFC 8414 §3 — origin validation in discoverXaiOidc
// ---------------------------------------------------------------------------
describe('discoverXaiOidc — RFC 8414 §3 origin validation', () => {
  beforeEach(() => {
    clearOidcCache();
  });

  it('happy path: all endpoints share the issuer origin', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).resolves.toMatchObject({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
  });

  it('happy path: device_authorization_endpoint on same origin is accepted', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
      device_authorization_endpoint: 'https://auth.x.ai/oauth2/device',
    } as Record<string, string>);
    const result = await discoverXaiOidc({
      fetchFn: fetchFn as unknown as typeof fetch,
      issuer: 'https://auth.x.ai',
    });
    expect(result.device_authorization_endpoint).toBe('https://auth.x.ai/oauth2/device');
  });

  it('throws when authorization_endpoint origin mismatches issuer', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://evil.example.com/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('authorization_endpoint origin does not match issuer');
  });

  it('throws when token_endpoint origin mismatches issuer', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://evil.example.com/oauth2/token',
    });
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('token_endpoint origin does not match issuer');
  });

  it('throws when device_authorization_endpoint origin mismatches issuer', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
      device_authorization_endpoint: 'https://evil.example.com/oauth2/device',
    } as Record<string, string>);
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('device_authorization_endpoint origin does not match issuer');
  });

  it('throws when userinfo_endpoint origin mismatches issuer', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://auth.x.ai',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
      userinfo_endpoint: 'https://evil.example.com/userinfo',
    } as Record<string, string>);
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('userinfo_endpoint origin does not match issuer');
  });

  it('throws a typed error when body issuer is a malformed URL (not-a-url)', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'not-a-url',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
    // After Item 2 fix: body issuer is validated against the configured issuer origin.
    // A malformed body issuer whose origin doesn't match should throw a clean typed error,
    // not a raw TypeError from `new URL('not-a-url')`.
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('xAI OIDC discovery: body issuer origin does not match configured issuer');
  });

  it('throws when body issuer origin differs from configured issuer', async () => {
    const fetchFn = makeFetchFn({
      issuer: 'https://evil.example.com',
      authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch, issuer: 'https://auth.x.ai' }),
    ).rejects.toThrow('body issuer origin does not match configured issuer');
  });
});
