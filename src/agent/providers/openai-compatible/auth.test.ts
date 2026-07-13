/**
 * Auth resolver tests. Covers the full 4-tier precedence chain plus the
 * Codex CLI `auth.json` parser. All tests run against in-memory fakes — no
 * real disk reads, no real env reads.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveOpenAIAuth,
  parseCodexAuthJson,
  formatAuthDiagnostic,
  type AuthResolverDeps,
} from './auth.js';

/** Build a deps object with empty env and no-such-file fs by default. */
function deps(overrides: Partial<AuthResolverDeps> = {}): AuthResolverDeps {
  return {
    readEnv: () => undefined,
    homedir: () => '/home/test',
    readFile: () => null,
    ...overrides,
  };
}

describe('resolveOpenAIAuth — precedence', () => {
  it('returns config key first when present', () => {
    const r = resolveOpenAIAuth('sk-config-1234', deps({
      readEnv: () => 'sk-env-9999',
      readFile: () => JSON.stringify({ OPENAI_API_KEY: 'sk-codex-5555' }),
    }));
    expect(r.source).toBe('config');
    expect(r.apiKey).toBe('sk-config-1234');
    expect(r.last4).toBe('1234');
  });

  it('falls through to env when config key is undefined', () => {
    const r = resolveOpenAIAuth(undefined, deps({
      readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-env-9999' : undefined),
    }));
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('sk-env-9999');
    expect(r.last4).toBe('9999');
    expect(r.envVar).toBe('OPENAI_API_KEY');
  });

  it('falls through to env when config key is empty string', () => {
    const r = resolveOpenAIAuth('', deps({
      readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-env-9999' : undefined),
    }));
    expect(r.source).toBe('env');
  });

  it('falls through to CODEX_API_KEY when OPENAI_API_KEY is unset', () => {
    const r = resolveOpenAIAuth(undefined, deps({
      readEnv: (k) => (k === 'CODEX_API_KEY' ? 'sk-codex-env-7777' : undefined),
    }));
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('sk-codex-env-7777');
    expect(r.last4).toBe('7777');
    expect(r.envVar).toBe('CODEX_API_KEY');
  });

  it('prefers OPENAI_API_KEY when both env vars are set', () => {
    const r = resolveOpenAIAuth(undefined, deps({
      readEnv: (k) =>
        k === 'OPENAI_API_KEY'
          ? 'sk-openai-env-9999'
          : k === 'CODEX_API_KEY'
            ? 'sk-codex-env-7777'
            : undefined,
    }));
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('sk-openai-env-9999');
    expect(r.last4).toBe('9999');
    expect(r.envVar).toBe('OPENAI_API_KEY');
  });

  it('falls through to ~/.codex/auth.json (apikey mode) when env unset', () => {
    const r = resolveOpenAIAuth(undefined, deps({
      readFile: (p) =>
        p === '/home/test/.codex/auth.json'
          ? JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-codex-5555' })
          : null,
    }));
    expect(r.source).toBe('codex-cli');
    expect(r.apiKey).toBe('sk-codex-5555');
    expect(r.last4).toBe('5555');
  });

  it('reports no-usable-auth-codex-oauth when only ChatGPT OAuth is present', () => {
    const r = resolveOpenAIAuth(undefined, deps({
      readFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { access_token: 'eyJxxx', refresh_token: 'rt_xxx', account_id: 'acc' },
        }),
    }));
    expect(r.source).toBe('no-usable-auth-codex-oauth');
    expect(r.apiKey).toBeNull();
    expect(r.last4).toBeUndefined();
  });

  it('returns no-usable-auth when nothing is configured', () => {
    const r = resolveOpenAIAuth(undefined, deps());
    expect(r.source).toBe('no-usable-auth');
    expect(r.apiKey).toBeNull();
  });

  it('does not include raw token in any returned field', () => {
    const r = resolveOpenAIAuth('sk-secret-very-long-token-1234', deps());
    // last4 is the only token-derived value we expose.
    expect(r.last4).toBe('1234');
    const serialized = JSON.stringify(r);
    // Apikey is in the resolution object (callers need it to make requests)
    // but the redaction discipline is the *caller's* job — verify we expose
    // last4 correctly and don't accidentally synthesize other key-derived
    // strings.
    expect(serialized).toContain('1234');
    // Confidence check: no full-token substring leakage into source/last4.
    expect(r.source).not.toContain('secret');
    expect(r.last4).not.toContain('secret');
  });
});

describe('parseCodexAuthJson', () => {
  it('accepts apikey when OPENAI_API_KEY is set, regardless of auth_mode', () => {
    // Some Codex CLI versions don't reset auth_mode after `login --api-key`.
    // We treat the key field as authoritative.
    const r = parseCodexAuthJson(
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-1234' }),
    );
    expect(r).toEqual({ kind: 'apikey', apiKey: 'sk-1234' });
  });

  it('classifies chatgpt-mode auth without API key', () => {
    const r = parseCodexAuthJson(
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {} }),
    );
    expect(r.kind).toBe('chatgpt');
  });

  it('returns invalid on non-JSON input', () => {
    expect(parseCodexAuthJson('not json').kind).toBe('invalid');
  });

  it('returns invalid on non-object JSON', () => {
    expect(parseCodexAuthJson('"a string"').kind).toBe('invalid');
    expect(parseCodexAuthJson('null').kind).toBe('invalid');
    expect(parseCodexAuthJson('42').kind).toBe('invalid');
  });

  it('returns no-key when file is parseable but has neither key nor OAuth bundle', () => {
    expect(parseCodexAuthJson(JSON.stringify({})).kind).toBe('no-key');
    expect(parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: null })).kind).toBe('no-key');
    expect(parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: '' })).kind).toBe('no-key');
  });
});

describe('formatAuthDiagnostic', () => {
  it('renders config source with last4', () => {
    const msg = formatAuthDiagnostic({ apiKey: 'k', source: 'config', last4: '1234' });
    expect(msg).toContain('config');
    expect(msg).toContain('1234');
  });

  it('renders env source with last4', () => {
    const msg = formatAuthDiagnostic({
      apiKey: 'k',
      source: 'env',
      last4: '9999',
      envVar: 'CODEX_API_KEY',
    });
    expect(msg).toContain('CODEX_API_KEY');
    expect(msg).toContain('9999');
  });

  it('renders codex-cli source with last4', () => {
    const msg = formatAuthDiagnostic({ apiKey: 'k', source: 'codex-cli', last4: '5555' });
    expect(msg).toContain('Codex CLI');
    expect(msg).toContain('~/.codex/auth.json');
    expect(msg).toContain('5555');
  });

  it('renders no-usable-auth-codex-oauth with actionable next step', () => {
    const msg = formatAuthDiagnostic({ apiKey: null, source: 'no-usable-auth-codex-oauth' });
    expect(msg).toContain('codex login --api-key');
    expect(msg).toContain('OPENAI_API_KEY');
    // Critical: must explain WHY ChatGPT OAuth isn't usable AND how to opt in.
    expect(msg).toContain('API-key mode');
    expect(msg).toContain('AFK_OPENAI_CHATGPT_OAUTH');
  });

  it('renders no-usable-auth with all 3 next steps', () => {
    const msg = formatAuthDiagnostic({ apiKey: null, source: 'no-usable-auth' });
    expect(msg).toContain('OPENAI_API_KEY');
    expect(msg).toContain('codex login --api-key');
    expect(msg).toContain('AFK config');
  });

  it('never includes the raw apiKey in diagnostic output', () => {
    const msg = formatAuthDiagnostic({
      apiKey: 'sk-VERYSECRETTOKEN1234',
      source: 'config',
      last4: '1234',
    });
    expect(msg).not.toContain('VERYSECRET');
    expect(msg).not.toContain('sk-VERY');
  });
});

describe('resolveOpenAIAuth — ChatGPT-subscription OAuth (flag-gated, read-only)', () => {
  /** Build an unsigned JWT (header.payload.sig) with the given payload claims. */
  function makeJwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
  }
  const ACCESS = makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_jwt' },
    exp: 9999999999,
  });
  const chatgptAuthJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: ACCESS, refresh_token: 'rt_x', ...extra },
    });
  const flagOn = (k: string) => (k === 'AFK_OPENAI_CHATGPT_OAUTH' ? '1' : undefined);

  it('stays read-only-rejected when the opt-in flag is OFF (default)', () => {
    const r = resolveOpenAIAuth(undefined, deps({ readFile: () => chatgptAuthJson() }));
    expect(r.source).toBe('no-usable-auth-codex-oauth');
    expect(r.apiKey).toBeNull();
  });

  it('returns the access token tagged chatgpt-oauth when the flag is ON', () => {
    const r = resolveOpenAIAuth(undefined, deps({ readEnv: flagOn, readFile: () => chatgptAuthJson() }));
    expect(r.source).toBe('chatgpt-oauth');
    expect(r.apiKey).toBe(ACCESS);
    expect(r.accountId).toBe('acct_from_jwt');
    expect(r.expiresAt).toBe(9999999999);
  });

  it('prefers an explicit account_id field over the JWT claim', () => {
    const r = resolveOpenAIAuth(undefined, deps({ readEnv: flagOn, readFile: () => chatgptAuthJson({ account_id: 'acct_explicit' }) }));
    expect(r.accountId).toBe('acct_explicit');
  });

  it('lets an explicit API key still win over OAuth even with the flag ON', () => {
    const r = resolveOpenAIAuth('sk-explicit-1234', deps({ readEnv: flagOn, readFile: () => chatgptAuthJson() }));
    expect(r.source).toBe('config');
    expect(r.apiKey).toBe('sk-explicit-1234');
  });

  it('parseCodexAuthJson extracts accessToken/accountId/expiresAt from the token bag', () => {
    const r = parseCodexAuthJson(chatgptAuthJson());
    expect(r).toMatchObject({ kind: 'chatgpt', accessToken: ACCESS, accountId: 'acct_from_jwt', expiresAt: 9999999999 });
  });

  it('renders the chatgpt-oauth diagnostic with a masked account id (last4 only)', () => {
    const msg = formatAuthDiagnostic({ apiKey: 'tok', source: 'chatgpt-oauth', accountId: 'acct_wxyz', expiresAt: 9999999999 });
    expect(msg).toContain('ChatGPT subscription');
    expect(msg).toContain('wxyz');
    expect(msg).not.toContain('acct_wxyz');
  });
});

describe('resolveOpenAIAuth — forced ChatGPT OAuth (per-slot, flag-independent)', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ACCESS = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_slot' },
    exp: 9999999999,
  })}.sig`;
  const chatgptAuthJson = () =>
    JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: ACCESS } });

  it('selects the ChatGPT token over OPENAI_API_KEY and WITHOUT the global flag', () => {
    // OPENAI_API_KEY set, AFK_OPENAI_CHATGPT_OAUTH deliberately OFF — the per-slot
    // signal alone must win. This is the whole point: a keyed OpenAI model and a
    // ChatGPT-subscription model can coexist in one session.
    const r = resolveOpenAIAuth(
      undefined,
      deps({
        readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-env-should-not-win' : undefined),
        readFile: () => chatgptAuthJson(),
      }),
      true,
    );
    expect(r.source).toBe('chatgpt-oauth');
    expect(r.apiKey).toBe(ACCESS);
    expect(r.accountId).toBe('acct_slot');
  });

  it('beats an explicit config key too (the slot declaration is authoritative)', () => {
    const r = resolveOpenAIAuth('sk-explicit-1234', deps({ readFile: () => chatgptAuthJson() }), true);
    expect(r.source).toBe('chatgpt-oauth');
  });

  it('fails with a distinct source when no ChatGPT token exists', () => {
    const r = resolveOpenAIAuth(
      undefined,
      deps({ readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-env' : undefined), readFile: () => null }),
      true,
    );
    expect(r.source).toBe('no-usable-auth-forced-chatgpt-oauth');
    expect(r.apiKey).toBeNull();
  });

  it('does NOT alter precedence when the flag arg is false (regression)', () => {
    const r = resolveOpenAIAuth(
      undefined,
      deps({
        readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-env-9999' : undefined),
        readFile: () => chatgptAuthJson(),
      }),
      false,
    );
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('sk-env-9999');
  });

  it('renders an accurate diagnostic that names the slot, not the global flag', () => {
    const msg = formatAuthDiagnostic({ apiKey: null, source: 'no-usable-auth-forced-chatgpt-oauth' });
    expect(msg).toContain("provider: 'chatgpt-oauth'");
    expect(msg).not.toContain('Found ChatGPT/OAuth credentials');
  });
});
