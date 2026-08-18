/**
 * OAuth core tests — discovery, device-code, PKCE extras, refresh rotation.
 * All network is mocked via injectable fetch.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildPkceAuthorizeUrl,
  codeChallengeS256,
  discoverXaiOidc,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  pollDeviceCodeToken,
  refreshXaiTokens,
  startDeviceCodeFlow,
  tokenResponseToBundle,
  ensureFreshAccessToken,
} from './oauth.js';
import {
  XAI_OAUTH_AUTHORIZE_PLAN,
  XAI_OAUTH_AUTHORIZE_REFERRER,
  XAI_OAUTH_CLIENT_ID,
  XAI_REFRESH_SKEW_SECONDS,
} from './oauth-constants.js';
import type { XaiAuthStoreDeps, XaiTokenBundle } from './auth-store.js';
import { readXaiTokens } from './auth-store.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const discoveryDoc = {
  issuer: 'https://auth.x.ai',
  authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
  device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/auth',
};

function memStore(): XaiAuthStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    authPath: () => '/tmp/xai-oauth-test.json',
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, data) => {
      files.set(p, data);
    },
    // In-memory store: no real FS path for chmodSync.
    chmod: () => undefined,
    mkdir: () => undefined,
    unlink: (p) => {
      files.delete(p);
    },
    exists: (p) => files.has(p),
  };
}

describe('discoverXaiOidc', () => {
  it('parses discovery document', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(discoveryDoc));
    const d = await discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(d.token_endpoint).toBe(discoveryDoc.token_endpoint);
    expect(d.device_authorization_endpoint).toBe(discoveryDoc.device_authorization_endpoint);
  });

  it('throws on HTTP error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      discoverXaiOidc({ fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/discovery failed/);
  });
});

describe('device-code flow', () => {
  it('starts and returns user_code', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      const u = String(url);
      if (u.includes('openid-configuration')) return jsonResponse(discoveryDoc);
      if (u.includes('device/auth')) {
        return jsonResponse({
          device_code: 'dev-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/device',
          expires_in: 600,
          interval: 5,
        });
      }
      return jsonResponse({}, 404);
    });
    const { device } = await startDeviceCodeFlow({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(device.user_code).toBe('ABCD-EFGH');
    expect(device.device_code).toBe('dev-1');
  });

  it('poll maps authorization_pending', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: 'authorization_pending' }, 400),
    );
    const r = await pollDeviceCodeToken(
      {
        issuer: discoveryDoc.issuer,
        authorization_endpoint: discoveryDoc.authorization_endpoint,
        token_endpoint: discoveryDoc.token_endpoint,
      },
      'dev-1',
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.status).toBe('pending');
  });

  it('poll returns success tokens', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
    const r = await pollDeviceCodeToken(
      {
        issuer: discoveryDoc.issuer,
        authorization_endpoint: discoveryDoc.authorization_endpoint,
        token_endpoint: discoveryDoc.token_endpoint,
      },
      'dev-1',
      { fetchFn: fetchFn as unknown as typeof fetch, nowSeconds: () => 1_000 },
    );
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.tokens.access_token).toBe('at-1');
      expect(r.tokens.refresh_token).toBe('rt-1');
      expect(r.tokens.expires_at).toBe(1_000 + 3600);
    }
  });
});

describe('PKCE authorize URL', () => {
  it('includes plan=generic, referrer, and PKCE params', () => {
    const verifier = generateCodeVerifier();
    const params = buildPkceAuthorizeUrl(
      {
        issuer: discoveryDoc.issuer,
        authorization_endpoint: discoveryDoc.authorization_endpoint,
        token_endpoint: discoveryDoc.token_endpoint,
      },
      { codeVerifier: verifier, state: 'st-1' },
    );
    const url = new URL(params.authorizationUrl);
    expect(url.searchParams.get('plan')).toBe(XAI_OAUTH_AUTHORIZE_PLAN);
    expect(url.searchParams.get('referrer')).toBe(XAI_OAUTH_AUTHORIZE_REFERRER);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallengeS256(verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('returns token bundle on success', async () => {
    // expires_in must exceed the floor guard (XAI_REFRESH_SKEW_SECONDS + 60 = 240s)
    // added in 2339b1cc (#1059), otherwise tokenResponseToBundle clamps it up.
    const EXPIRES_IN = 3600;
    const NOW = 50;
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: 'at-code',
        refresh_token: 'rt-code',
        expires_in: EXPIRES_IN,
      }),
    );
    const tokens = await exchangeAuthorizationCode(
      {
        issuer: discoveryDoc.issuer,
        authorization_endpoint: discoveryDoc.authorization_endpoint,
        token_endpoint: discoveryDoc.token_endpoint,
      },
      { code: 'c', codeVerifier: 'v' },
      { fetchFn: fetchFn as unknown as typeof fetch, nowSeconds: () => NOW },
    );
    expect(tokens.access_token).toBe('at-code');
    expect(tokens.expires_at).toBe(NOW + EXPIRES_IN);
  });
});

describe('refreshXaiTokens — rotation', () => {
  it('persists NEW access_token and NEW refresh_token', async () => {
    const store = memStore();
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      const u = String(url);
      if (u.includes('openid-configuration')) return jsonResponse(discoveryDoc);
      return jsonResponse({
        access_token: 'access-NEW',
        refresh_token: 'refresh-NEW',
        expires_in: 3600,
      });
    });
    const tokens = await refreshXaiTokens('refresh-OLD', {
      fetchFn: fetchFn as unknown as typeof fetch,
      store,
      nowSeconds: () => 10_000,
    });
    expect(tokens.access_token).toBe('access-NEW');
    expect(tokens.refresh_token).toBe('refresh-NEW');
    const onDisk = readXaiTokens(store);
    expect(onDisk?.access_token).toBe('access-NEW');
    expect(onDisk?.refresh_token).toBe('refresh-NEW');
    // Must not keep the old refresh token.
    expect(onDisk?.refresh_token).not.toBe('refresh-OLD');
  });
});

describe('ensureFreshAccessToken', () => {
  it('returns existing bundle when not near expiry', async () => {
    const store = memStore();
    const now = 1_000_000;
    const bundle: XaiTokenBundle = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: now + XAI_REFRESH_SKEW_SECONDS + 60,
    };
    const { writeXaiTokens } = await import('./auth-store.js');
    writeXaiTokens(bundle, store);
    const fetchFn = vi.fn();
    const got = await ensureFreshAccessToken({
      store,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSeconds: () => now,
    });
    expect(got?.access_token).toBe('a');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes when within skew', async () => {
    const store = memStore();
    const now = 1_000_000;
    const { writeXaiTokens } = await import('./auth-store.js');
    writeXaiTokens(
      {
        access_token: 'old',
        refresh_token: 'rt-old',
        expires_at: now + 30, // within 3m skew
      },
      store,
    );
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      if (String(url).includes('openid-configuration')) return jsonResponse(discoveryDoc);
      return jsonResponse({
        access_token: 'fresh',
        refresh_token: 'rt-fresh',
        expires_in: 3600,
      });
    });
    const got = await ensureFreshAccessToken({
      store,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSeconds: () => now,
    });
    expect(got?.access_token).toBe('fresh');
    expect(readXaiTokens(store)?.refresh_token).toBe('rt-fresh');
  });

  it('falls back to current token when refresh fails but token is still valid', async () => {
    const store = memStore();
    const now = 1_000_000;
    const { writeXaiTokens } = await import('./auth-store.js');
    // Token is past the refresh skew threshold (needs refresh) but not yet hard-expired.
    writeXaiTokens(
      {
        access_token: 'still-valid',
        refresh_token: 'rt-current',
        expires_at: now + 30, // within skew → refresh triggered, but > now → not expired
      },
      store,
    );
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      if (String(url).includes('openid-configuration')) return jsonResponse(discoveryDoc);
      // Refresh call fails with a transient server error.
      return jsonResponse({ error: 'server_error' }, 500);
    });
    const got = await ensureFreshAccessToken({
      store,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSeconds: () => now,
    });
    // Should NOT throw — falls back to the existing valid token.
    expect(got?.access_token).toBe('still-valid');
    // The original token must remain in the store (not cleared).
    expect(readXaiTokens(store)?.access_token).toBe('still-valid');
  });

  it('clears store when refresh fails and access token is fully expired', async () => {
    const store = memStore();
    const now = 1_000_000;
    const { writeXaiTokens } = await import('./auth-store.js');
    writeXaiTokens(
      {
        access_token: 'dead',
        refresh_token: 'rt-dead',
        expires_at: now - 10,
      },
      store,
    );
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      if (String(url).includes('openid-configuration')) return jsonResponse(discoveryDoc);
      return jsonResponse({ error: 'invalid_grant' }, 400);
    });
    const got = await ensureFreshAccessToken({
      store,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSeconds: () => now,
    });
    expect(got).toBeNull();
    expect(readXaiTokens(store)).toBeNull();
  });

  it('single-flights concurrent refresh for the same store path', async () => {
    const store = memStore();
    store.authPath = () => '/tmp/xai-oauth-singleflight.json';
    const now = 1_000_000;
    const { writeXaiTokens } = await import('./auth-store.js');
    writeXaiTokens(
      {
        access_token: 'old',
        refresh_token: 'rt-old',
        expires_at: now + 30,
      },
      store,
    );

    let tokenCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchFn = vi.fn(async (url: RequestInfo) => {
      if (String(url).includes('openid-configuration')) return jsonResponse(discoveryDoc);
      tokenCalls += 1;
      await gate;
      return jsonResponse({
        access_token: 'shared-fresh',
        refresh_token: 'rt-shared',
        expires_in: 3600,
      });
    });

    const deps = {
      store,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowSeconds: () => now,
    };
    const p1 = ensureFreshAccessToken(deps);
    const p2 = ensureFreshAccessToken(deps);
    // Let both enter the in-flight path before the token response resolves.
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a?.access_token).toBe('shared-fresh');
    expect(b?.access_token).toBe('shared-fresh');
    expect(tokenCalls).toBe(1);
  });
});

describe('tokenResponseToBundle', () => {
  it('uses fallback refresh when response omits rotation', () => {
    const b = tokenResponseToBundle(
      { access_token: 'a', expires_in: 3600 },
      () => 100,
      'fallback-rt',
    );
    expect(b?.refresh_token).toBe('fallback-rt');
    expect(b?.expires_at).toBe(3700);
  });
});
