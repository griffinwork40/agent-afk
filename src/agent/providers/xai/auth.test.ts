import { describe, it, expect } from 'vitest';
import {
  formatXaiAuthDiagnostic,
  formatXaiHttpAuthError,
  resolveXaiAuth,
  type XaiAuthResolverDeps,
} from './auth.js';
import type { XaiAuthStoreDeps } from './auth-store.js';

function storeWith(tokens: {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}): XaiAuthStoreDeps {
  const files = new Map<string, string>();
  const path = '/tmp/xai-auth-test.json';
  files.set(path, JSON.stringify(tokens));
  return {
    authPath: () => path,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, d) => {
      files.set(p, d);
    },
    mkdir: () => undefined,
    unlink: (p) => {
      files.delete(p);
    },
    exists: (p) => files.has(p),
  };
}

function deps(overrides: Partial<XaiAuthResolverDeps> = {}): XaiAuthResolverDeps {
  return {
    readEnv: () => undefined,
    store: {
      authPath: () => '/tmp/missing.json',
      readFile: () => null,
    },
    ...overrides,
  };
}

const oauth = {
  access_token: 'oauth-access-zzzz',
  refresh_token: 'oauth-refresh',
  expires_at: 2_000_000_000,
};

describe('resolveXaiAuth', () => {
  it('force apikey uses config then env', () => {
    const r = resolveXaiAuth('cfg-key-1111', 'apikey', deps());
    expect(r.source).toBe('config');
    expect(r.mode).toBe('apikey');
    expect(r.last4).toBe('1111');

    const r2 = resolveXaiAuth(undefined, 'apikey', deps({
      readEnv: (k) => (k === 'XAI_API_KEY' ? 'env-key-2222' : undefined),
    }));
    expect(r2.source).toBe('env');
    expect(r2.envVar).toBe('XAI_API_KEY');
  });

  it('force oauth ignores API key', () => {
    const r = resolveXaiAuth('cfg-key', 'oauth', deps({
      store: storeWith(oauth),
      readEnv: () => 'env-key',
    }));
    expect(r.source).toBe('xai-oauth');
    expect(r.apiKey).toBe(oauth.access_token);
    expect(r.last4).toBe('zzzz');
  });

  it('force oauth with no tokens fails distinctly', () => {
    const r = resolveXaiAuth(undefined, 'oauth', deps());
    expect(r.source).toBe('no-usable-auth-forced-xai-oauth');
    expect(r.apiKey).toBeNull();
  });

  it('auto: only key → apikey', () => {
    const r = resolveXaiAuth(undefined, undefined, deps({
      readEnv: (k) => (k === 'XAI_API_KEY' ? 'only-key-3333' : undefined),
    }));
    expect(r.mode).toBe('apikey');
    expect(r.source).toBe('env');
  });

  it('auto: only oauth → oauth', () => {
    const r = resolveXaiAuth(undefined, undefined, deps({ store: storeWith(oauth) }));
    expect(r.mode).toBe('oauth');
    expect(r.source).toBe('xai-oauth');
  });

  it('auto: both → ambiguous, no silent pick', () => {
    const r = resolveXaiAuth(undefined, undefined, deps({
      readEnv: (k) => (k === 'XAI_API_KEY' ? 'k' : undefined),
      store: storeWith(oauth),
    }));
    expect(r.source).toBe('ambiguous-auth');
    expect(r.apiKey).toBeNull();
  });

  it('auto: neither → no-usable-auth', () => {
    const r = resolveXaiAuth(undefined, undefined, deps());
    expect(r.source).toBe('no-usable-auth');
  });

  // Session bootstrap must NOT pass OAuth access tokens as config.apiKey.
  // When that regression is present, auto mode looks like keyHit+oauthHit.
  it('auto: oauth store only (no env, no config key) → oauth mode, not ambiguous', () => {
    const r = resolveXaiAuth(undefined, undefined, deps({ store: storeWith(oauth) }));
    expect(r.source).toBe('xai-oauth');
    expect(r.mode).toBe('oauth');
    expect(r.apiKey).toBe(oauth.access_token);
    expect(r.source).not.toBe('ambiguous-auth');
  });

  it('auto: config key that looks like a token + oauth store → still ambiguous', () => {
    // Documents why injection is forbidden: any non-empty config.apiKey
    // alongside a store is ambiguous in auto mode.
    const r = resolveXaiAuth(oauth.access_token, undefined, deps({ store: storeWith(oauth) }));
    expect(r.source).toBe('ambiguous-auth');
  });
});

describe('formatXaiAuthDiagnostic', () => {
  it('never includes full tokens', () => {
    const r = resolveXaiAuth(undefined, undefined, deps({ store: storeWith(oauth) }));
    const msg = formatXaiAuthDiagnostic(r);
    expect(msg).toContain('zzzz');
    expect(msg).not.toContain(oauth.access_token);
    expect(msg).not.toContain(oauth.refresh_token);
  });

  it('ambiguous names both modes', () => {
    const msg = formatXaiAuthDiagnostic({ apiKey: null, source: 'ambiguous-auth' });
    expect(msg).toContain('--provider xai');
    expect(msg).toContain('--provider xai-oauth');
  });
});

describe('formatXaiHttpAuthError', () => {
  it('403 mentions Heavy and proxy', () => {
    const msg = formatXaiHttpAuthError(403, { mode: 'oauth' });
    expect(msg).toContain('SuperGrok Heavy');
    expect(msg).toContain('cli-chat-proxy');
    expect(msg).toContain('XAI_API_KEY');
  });

  it('402 mentions spend gate', () => {
    const msg = formatXaiHttpAuthError(402, {
      mode: 'oauth',
      bodySnippet: 'personal-team-blocked:spending-limit',
    });
    expect(msg).toContain('402');
    expect(msg).toContain('personal-team-blocked');
  });
});
