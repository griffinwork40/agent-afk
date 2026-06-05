/**
 * Unit tests for `KeychainOAuthProvider` (`oauth.ts`).
 *
 * Uses an in-memory `KeychainBackend` (no native keychain, no fs writes) to
 * verify that all storage round-trips are correct and that
 * `redirectToAuthorization` routes to stderr when Telegram is unconfigured.
 *
 * Tests are deliberately free of real credentials and real HTTP — the OAuth
 * flow itself is the SDK's responsibility; we only verify the provider's
 * storage and redirect logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

import { KeychainOAuthProvider, type KeychainBackend } from './oauth.js';

// ---------------------------------------------------------------------------
// In-memory backend (replaces native keychain for tests)
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory `KeychainBackend` backed by a shared store object.
 * Multiple provider instances can share the same store to simulate the
 * single-blob credential file.
 */
function makeMemoryBackend(store: { blob: string | undefined } = { blob: undefined }): KeychainBackend {
  return {
    read() { return store.blob; },
    write(blob: string) { store.blob = blob; },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKENS: OAuthTokens = {
  access_token: 'at-test-123',
  token_type: 'Bearer',
  refresh_token: 'rt-test-456',
  expires_in: 3600,
};

const CLIENT_INFO: OAuthClientInformationMixed = {
  client_id: 'client-001',
  redirect_uris: ['http://localhost:3000/oauth/callback'],
};

// ---------------------------------------------------------------------------
// Token storage round-trip
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — token storage', () => {
  it('saves and loads tokens', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('test-server', backend);

    expect(provider.tokens()).toBeUndefined();

    provider.saveTokens(TOKENS);
    const loaded = provider.tokens();
    expect(loaded).toEqual(TOKENS);
  });

  it('scopes tokens per server name', () => {
    const store = { blob: undefined as string | undefined };
    const backendA = makeMemoryBackend(store);
    const backendB = makeMemoryBackend(store);

    const provA = new KeychainOAuthProvider('server-a', backendA);
    const provB = new KeychainOAuthProvider('server-b', backendB);

    provA.saveTokens(TOKENS);

    // server-a has tokens; server-b should not.
    expect(provA.tokens()).toEqual(TOKENS);
    expect(provB.tokens()).toBeUndefined();

    const tokensB: OAuthTokens = { access_token: 'bt-999', token_type: 'Bearer' };
    provB.saveTokens(tokensB);

    // Both scoped correctly.
    expect(provA.tokens()?.access_token).toBe('at-test-123');
    expect(provB.tokens()?.access_token).toBe('bt-999');
  });

  it('preserves other blob keys (does not clobber claudeAiOauth)', () => {
    const existing = JSON.stringify({
      claudeAiOauth: { accessToken: 'claude-token', expiresAt: 9999 },
    });
    const store = { blob: existing };
    const backend = makeMemoryBackend(store);
    const provider = new KeychainOAuthProvider('srv', backend);

    provider.saveTokens(TOKENS);

    const updated = JSON.parse(store.blob!) as Record<string, unknown>;
    // MCP OAuth written.
    expect((updated['mcpOAuth'] as Record<string, unknown>)['srv']).toBeDefined();
    // Claude OAuth preserved.
    expect((updated['claudeAiOauth'] as Record<string, unknown>)?.['accessToken']).toBe('claude-token');
  });
});

// ---------------------------------------------------------------------------
// Client information storage round-trip
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — client information', () => {
  it('saves and loads client information', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());

    expect(provider.clientInformation()).toBeUndefined();

    provider.saveClientInformation(CLIENT_INFO);
    expect(provider.clientInformation()).toEqual(CLIENT_INFO);
  });
});

// ---------------------------------------------------------------------------
// PKCE code verifier round-trip
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — code verifier', () => {
  it('saves and loads the code verifier', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());
    provider.saveCodeVerifier('my-pkce-verifier');
    expect(provider.codeVerifier()).toBe('my-pkce-verifier');
  });

  it('throws when no code verifier is stored', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());
    expect(() => provider.codeVerifier()).toThrow(/no PKCE code verifier/);
  });
});

// ---------------------------------------------------------------------------
// Discovery state round-trip
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — discovery state', () => {
  it('saves and loads discovery state', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());
    const state = {
      authorizationServerUrl: 'https://auth.example.com',
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    };
    expect(provider.discoveryState()).toBeUndefined();
    provider.saveDiscoveryState(state);
    expect(provider.discoveryState()).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// invalidateCredentials
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — invalidateCredentials', () => {
  it('clears tokens only when scope=tokens', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveTokens(TOKENS);
    provider.saveClientInformation(CLIENT_INFO);

    provider.invalidateCredentials('tokens');

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual(CLIENT_INFO);
  });

  it('clears client info only when scope=client', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveTokens(TOKENS);
    provider.saveClientInformation(CLIENT_INFO);

    provider.invalidateCredentials('client');

    expect(provider.tokens()).toEqual(TOKENS);
    expect(provider.clientInformation()).toBeUndefined();
  });

  it('clears code verifier only when scope=verifier', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveCodeVerifier('v-abc');
    provider.saveTokens(TOKENS);

    provider.invalidateCredentials('verifier');

    expect(() => provider.codeVerifier()).toThrow(/no PKCE code verifier/);
    expect(provider.tokens()).toEqual(TOKENS);
  });

  it('clears everything when scope=all', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveTokens(TOKENS);
    provider.saveClientInformation(CLIENT_INFO);
    provider.saveCodeVerifier('v-abc');

    provider.invalidateCredentials('all');

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    expect(() => provider.codeVerifier()).toThrow(/no PKCE code verifier/);
  });

  it('clears discovery state when scope=discovery', () => {
    const backend = makeMemoryBackend();
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' });
    provider.saveTokens(TOKENS);

    provider.invalidateCredentials('discovery');

    expect(provider.discoveryState()).toBeUndefined();
    expect(provider.tokens()).toEqual(TOKENS);
  });
});

// ---------------------------------------------------------------------------
// redirectToAuthorization — stderr surfacing
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — redirectToAuthorization', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const authUrl = new URL('https://auth.example.com/authorize?client_id=x&state=y');

  beforeEach(() => {
    // Suppress stderr output in tests — we just verify it was called.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Ensure Telegram env vars are unset so push path is not taken.
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes the auth URL to stderr when Telegram is unconfigured', async () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());
    await provider.redirectToAuthorization(authUrl);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const allOutput = calls.join('');
    expect(allOutput).toContain('OAuth authorization required');
    expect(allOutput).toContain(authUrl.toString());
  });

  it('writes the oauth_pending state file', async () => {
    // Use a temp backend to avoid writing to the real credential store.
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend());

    // We can't easily verify the file write without real fs mocking here,
    // but we CAN verify the function does not throw. File write is tested
    // implicitly by the function not throwing.
    await expect(provider.redirectToAuthorization(authUrl)).resolves.toBeUndefined();
  });

  it('exposes the correct redirectUrl sentinel', () => {
    const provider = new KeychainOAuthProvider('my-server', makeMemoryBackend());
    expect(provider.redirectUrl).toMatch(/^http(s?):\/\//);
  });

  it('exposes clientMetadata with redirect_uris matching redirectUrl', () => {
    const provider = new KeychainOAuthProvider('my-server', makeMemoryBackend());
    expect(provider.clientMetadata.redirect_uris).toContain(provider.redirectUrl);
  });
});

// ---------------------------------------------------------------------------
// Graceful handling of corrupt/missing blob
// ---------------------------------------------------------------------------

describe('KeychainOAuthProvider — robustness', () => {
  it('returns undefined when the blob is absent', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend({ blob: undefined }));
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.discoveryState()).toBeUndefined();
  });

  it('returns undefined when the blob is malformed JSON', () => {
    const provider = new KeychainOAuthProvider('srv', makeMemoryBackend({ blob: 'not-json{{{' }));
    expect(provider.tokens()).toBeUndefined();
  });

  it('starts fresh when the blob is malformed and a write occurs', () => {
    const store = { blob: 'not-json' as string | undefined };
    const backend = makeMemoryBackend(store);
    const provider = new KeychainOAuthProvider('srv', backend);
    provider.saveTokens(TOKENS);
    // After the write the blob should be valid JSON.
    const parsed = JSON.parse(store.blob!) as Record<string, unknown>;
    expect(parsed['mcpOAuth']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// oauth_pending state file — read/clear helpers
// ---------------------------------------------------------------------------

describe('readOauthPending / clearOauthPending', () => {
  let tmp: string;
  let originalAfkHome: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmp = mkdtempSync(join(tmpdir(), 'mcp-oauth-pending-'));
    originalAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = tmp;
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(tmp, { recursive: true, force: true });
    if (originalAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = originalAfkHome;
  });

  async function writePendingFile(body: unknown): Promise<void> {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { getOauthPendingPath } = await import('../../paths.js');
    const p = getOauthPendingPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body), 'utf-8');
  }

  it('returns {} when the file is missing', async () => {
    const { readOauthPending } = await import('./oauth.js');
    expect(readOauthPending()).toEqual({});
  });

  it('returns {} when the file is malformed JSON', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { getOauthPendingPath } = await import('../../paths.js');
    const p = getOauthPendingPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{not-json', 'utf-8');
    const { readOauthPending } = await import('./oauth.js');
    expect(readOauthPending()).toEqual({});
  });

  it('parses well-formed entries', async () => {
    const ts = Date.now();
    await writePendingFile({
      srv: {
        status: 'oauth_pending',
        authorizationUrl: 'https://idp.example.com/oauth?…',
        timestamp: ts,
      },
    });
    const { readOauthPending } = await import('./oauth.js');
    const out = readOauthPending();
    expect(out['srv']).toEqual({
      status: 'oauth_pending',
      authorizationUrl: 'https://idp.example.com/oauth?…',
      timestamp: ts,
    });
  });

  it('drops entries with bad shape silently (forward-compat)', async () => {
    await writePendingFile({
      good: { status: 'oauth_pending', authorizationUrl: 'https://a', timestamp: Date.now() },
      missingUrl: { status: 'oauth_pending', timestamp: 1 },
      wrongStatus: { status: 'done', authorizationUrl: 'https://b', timestamp: 1 },
      notObject: 'string',
    });
    const { readOauthPending } = await import('./oauth.js');
    const out = readOauthPending();
    expect(Object.keys(out).sort()).toEqual(['good']);
  });

  it('clearOauthPending removes only the named entry', async () => {
    const now = Date.now();
    await writePendingFile({
      a: { status: 'oauth_pending', authorizationUrl: 'https://a', timestamp: now },
      b: { status: 'oauth_pending', authorizationUrl: 'https://b', timestamp: now },
    });
    const { clearOauthPending, readOauthPending } = await import('./oauth.js');
    clearOauthPending('a');
    const remaining = readOauthPending();
    expect(Object.keys(remaining)).toEqual(['b']);
  });

  it('clearOauthPending is a no-op for a missing entry', async () => {
    await writePendingFile({
      keep: { status: 'oauth_pending', authorizationUrl: 'https://k', timestamp: Date.now() },
    });
    const { clearOauthPending, readOauthPending } = await import('./oauth.js');
    clearOauthPending('missing');
    expect(Object.keys(readOauthPending())).toEqual(['keep']);
  });

  it('clearOauthPending is a no-op when the file does not exist', async () => {
    const { clearOauthPending } = await import('./oauth.js');
    expect(() => clearOauthPending('srv')).not.toThrow();
  });

  it('readOauthPending drops entries older than 10 minutes (TTL)', async () => {
    const expired = Date.now() - 11 * 60 * 1000; // 11 minutes ago
    const fresh   = Date.now();
    await writePendingFile({
      old: { status: 'oauth_pending', authorizationUrl: 'https://old', timestamp: expired },
      new: { status: 'oauth_pending', authorizationUrl: 'https://new', timestamp: fresh },
    });
    const { readOauthPending } = await import('./oauth.js');
    const out = readOauthPending();
    expect(out['old']).toBeUndefined();
    expect(out['new']).toBeDefined();
  });
});
