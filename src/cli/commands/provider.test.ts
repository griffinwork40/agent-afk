/**
 * Tests for the `afk provider auth diagnose` command's pure builder.
 *
 * The CLI wrapper around it (Commander action) is exercised by the e2e
 * snapshot harness; here we only verify the data shape so the JSON contract
 * with downstream shell scripts is locked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProviderAuthDiagnose, buildXaiAuthDiagnose } from './provider.js';

describe('buildProviderAuthDiagnose', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_API_KEY'];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns exit code 0 when explicit config key is provided', () => {
    const r = buildProviderAuthDiagnose('sk-explicit-1234');
    expect(r.exitCode).toBe(0);
    expect(r.source).toBe('config');
    expect(r.last4).toBe('1234');
    expect(r.message).toMatch(/config/i);
  });

  it('returns exit code 0 when OPENAI_API_KEY is set', () => {
    process.env['OPENAI_API_KEY'] = 'sk-env-9999';
    const r = buildProviderAuthDiagnose(undefined);
    expect(r.exitCode).toBe(0);
    expect(r.source).toBe('env');
    expect(r.last4).toBe('9999');
  });

  it('returns nonzero exit code with actionable message when no auth resolves', () => {
    // Inject hermetic deps so this test is isolated from the host machine's
    // real credentials. Without this, a developer whose ~/.codex/auth.json
    // contains a ChatGPT OAuth bundle (and AFK_OPENAI_CHATGPT_OAUTH=1) would
    // cause resolveOpenAIAuth to return source:'chatgpt-oauth' with a real
    // access_token — making exitCode 0 and source outside the allowlist below.
    const hermeticDeps = {
      readEnv: (key: string) => {
        // Expose only the env vars already cleared by beforeEach (OPENAI_API_KEY,
        // CODEX_API_KEY) as absent, and explicitly suppress the OAuth opt-in flag.
        if (key === 'OPENAI_API_KEY' || key === 'CODEX_API_KEY' || key === 'AFK_OPENAI_CHATGPT_OAUTH') {
          return undefined;
        }
        return undefined;
      },
      homedir: () => '/nonexistent-test-home',
      readFile: (_path: string) => null, // no ~/.codex/auth.json
    };
    const r = buildProviderAuthDiagnose(undefined, hermeticDeps);
    // With no env vars and no filesystem auth the resolver must return
    // no-usable-auth (exitCode 1) with an actionable message.
    expect(r.exitCode).toBe(1);
    expect(r.message.toLowerCase()).toMatch(/openai_api_key|codex login/);
  });

  it('never includes raw key material in the returned message', () => {
    const r = buildProviderAuthDiagnose('sk-VERYSECRETVALUE1234');
    expect(r.message).not.toContain('VERYSECRET');
    expect(r.message).not.toContain('sk-VERY');
    // last4 is fine
    expect(r.last4).toBe('1234');
  });
});

describe('buildXaiAuthDiagnose', () => {
  it('reports config key', () => {
    const r = buildXaiAuthDiagnose('xai-key-abcd', 'apikey', {
      readEnv: () => undefined,
      store: { authPath: () => '/nope', readFile: () => null },
    });
    expect(r.exitCode).toBe(0);
    expect(r.source).toBe('config');
    expect(r.last4).toBe('abcd');
    expect(r.message).not.toContain('xai-key-abcd');
  });

  it('reports no-usable-auth with hermetic store', () => {
    const r = buildXaiAuthDiagnose(undefined, undefined, {
      readEnv: () => undefined,
      store: { authPath: () => '/nope', readFile: () => null },
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/XAI_API_KEY|provider auth xai login/i);
  });
});

describe('diagnose JSON back-compat fields', () => {
  it('buildProviderAuthDiagnose still exposes flat OpenAI shape fields', () => {
    // Scripts depend on top-level source/message/exitCode; the CLI now also
    // nests openai/xai but must keep the builder contract for OpenAI.
    const r = buildProviderAuthDiagnose('sk-explicit-1234');
    expect(r).toMatchObject({
      source: 'config',
      exitCode: 0,
      last4: '1234',
    });
    expect(r.message).toMatch(/config/i);
  });
});

describe('buildProviderAuthDiagnose — slot-aware / forceChatgptOAuth (item 1 fix)', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  function makeFutureJwt(): string {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_slot_diag' },
      exp,
    })}.sig`;
  }

  function makePastJwt(): string {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_slot_diag' },
      exp,
    })}.sig`;
  }

  const hermeticDepsWithOAuthToken = (accessToken: string) => ({
    readEnv: (_k: string) => undefined, // AFK_OPENAI_CHATGPT_OAUTH deliberately OFF
    homedir: () => '/home/testslot',
    readFile: (_p: string) =>
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { access_token: accessToken },
      }),
  });

  it('without forceChatgptOAuth, a chatgpt-oauth token is NOT selected (flag-gated behaviour)', () => {
    // AFK_OPENAI_CHATGPT_OAUTH is OFF and forceChatgptOAuth=false: the resolver
    // must return no-usable-auth-codex-oauth, NOT chatgpt-oauth.
    const r = buildProviderAuthDiagnose(
      undefined,
      hermeticDepsWithOAuthToken(makeFutureJwt()),
      false,
    );
    expect(r.source).toBe('no-usable-auth-codex-oauth');
    expect(r.exitCode).toBe(1);
  });

  it('with forceChatgptOAuth=true, selects the chatgpt-oauth token (models --model chatgpt-oauth slot)', () => {
    // Simulates `afk provider auth diagnose --model medium` when medium is
    // bound to provider: 'chatgpt-oauth'.
    const r = buildProviderAuthDiagnose(
      undefined,
      hermeticDepsWithOAuthToken(makeFutureJwt()),
      true, // forceChatgptOAuth
    );
    expect(r.source).toBe('chatgpt-oauth');
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain('ChatGPT subscription');
  });

  it('with forceChatgptOAuth=true and expired token, returns no-usable-auth-forced-chatgpt-oauth (exit 1)', () => {
    const r = buildProviderAuthDiagnose(
      undefined,
      hermeticDepsWithOAuthToken(makePastJwt()),
      true,
    );
    expect(r.source).toBe('no-usable-auth-forced-chatgpt-oauth');
    expect(r.exitCode).toBe(1);
    // The message must give actionable guidance (re-run codex or change the slot).
    expect(r.message).toMatch(/re-run `codex`|change the slot/i);
  });
});
