/**
 * Tests for the `afk provider auth diagnose` command's pure builder.
 *
 * The CLI wrapper around it (Commander action) is exercised by the e2e
 * snapshot harness; here we only verify the data shape so the JSON contract
 * with downstream shell scripts is locked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProviderAuthDiagnose, buildXaiAuthDiagnose } from './provider.js';
import {
  setSlotBindings,
  resetSlotBindings,
  type ModelSlots,
} from '../../agent/session/model-slots.js';

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

// ---------------------------------------------------------------------------
// Slot-aware diagnose tests (#555)
// ---------------------------------------------------------------------------

/**
 * Hermetic deps for the slot-aware tests: no env vars, no filesystem.
 * Provides a fake ~/.codex/auth.json with a ChatGPT OAuth bundle so the
 * forceChatgptOAuth path can resolve a token without touching the real disk.
 */
const hermeticDepsWithChatGptToken = {
  readEnv: (_key: string) => undefined,
  homedir: () => '/fake-home',
  readFile: (path: string) => {
    if (path.includes('auth.json')) {
      return JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'chatgpt-oauth-token-abcd' },
      });
    }
    return null;
  },
};

/** Hermetic deps with no auth at all (no token, no API key). */
const hermeticDepsEmpty = {
  readEnv: (_key: string) => undefined,
  homedir: () => '/nonexistent-test-home',
  readFile: (_path: string) => null,
};

describe('buildProviderAuthDiagnose — slot-aware (forceChatgptOAuth)', () => {
  it('resolves chatgpt-oauth source when forceChatgptOAuth is true and token exists', () => {
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsWithChatGptToken, true);
    expect(r.source).toBe('chatgpt-oauth');
    expect(r.exitCode).toBe(0);
    expect(r.last4).toBe('abcd');
    expect(r.message).toMatch(/chatgpt subscription oauth/i);
    // Never leaks raw token
    expect(r.message).not.toContain('chatgpt-oauth-token');
  });

  it('returns no-usable-auth-forced-chatgpt-oauth when forceChatgptOAuth is true but no token', () => {
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsEmpty, true);
    expect(r.source).toBe('no-usable-auth-forced-chatgpt-oauth');
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/chatgpt-oauth/i);
    expect(r.message).toMatch(/codex/i);
  });

  it('ignores forceChatgptOAuth=false even when a ChatGPT token exists — falls back to no-usable-auth', () => {
    // When forceChatgptOAuth is false, the ChatGPT token in auth.json is
    // ignored because AFK_OPENAI_CHATGPT_OAUTH is not set (hermeticDeps has
    // readEnv returning undefined for it).
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsWithChatGptToken, false);
    // Source should be no-usable-auth-codex-oauth (found OAuth but not using it)
    expect(r.source).toBe('no-usable-auth-codex-oauth');
    expect(r.exitCode).toBe(1);
  });

  it('is backward-compatible: third param absent behaves like forceChatgptOAuth=false', () => {
    const withFlag = buildProviderAuthDiagnose(undefined, hermeticDepsEmpty, false);
    const withoutFlag = buildProviderAuthDiagnose(undefined, hermeticDepsEmpty);
    expect(withFlag.source).toBe(withoutFlag.source);
    expect(withFlag.exitCode).toBe(withoutFlag.exitCode);
  });
});

describe('diagnose --slot flag slot binding resolution', () => {
  // A fake ModelSlots table with one chatgpt-oauth slot and one openai slot.
  const fakeBindings: ModelSlots = {
    local: { id: '' },
    small: { id: 'gpt-4o-mini', provider: 'openai' },
    medium: { id: 'chatgpt-4o-latest', provider: 'chatgpt-oauth' },
    large: { id: 'gpt-4o', provider: 'openai' },
  };

  beforeEach(() => {
    setSlotBindings(fakeBindings);
  });
  afterEach(() => {
    resetSlotBindings();
  });

  it('forceChatgptOAuth=true for chatgpt-oauth slot → resolves ChatGPT token', () => {
    // Simulate what the CLI action does when --slot medium is passed:
    // the slot has provider:'chatgpt-oauth', so forceChatgptOAuth should be true.
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsWithChatGptToken, true);
    expect(r.source).toBe('chatgpt-oauth');
    expect(r.exitCode).toBe(0);
  });

  it('forceChatgptOAuth=false for non-chatgpt-oauth slot → normal API-key resolution', () => {
    // Simulate --slot small (provider:'openai'): forceChatgptOAuth=false, normal path.
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsEmpty, false);
    expect(r.source).toBe('no-usable-auth');
    expect(r.exitCode).toBe(1);
  });

  it('forceChatgptOAuth=false for unknown slot name → normal API-key resolution', () => {
    // A slot name that doesn't exist in bindings → slotForInput returns undefined
    // → forceChatgptOAuth stays false → normal resolution.
    const r = buildProviderAuthDiagnose(undefined, hermeticDepsEmpty, false);
    expect(r.source).toBe('no-usable-auth');
    expect(r.exitCode).toBe(1);
  });
});
