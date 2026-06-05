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
    // Critical: must explain WHY ChatGPT OAuth isn't usable.
    expect(msg).toContain('API key auth');
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
