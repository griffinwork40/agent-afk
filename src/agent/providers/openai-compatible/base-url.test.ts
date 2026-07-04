import { describe, it, expect } from 'vitest';
import { resolveEffectiveOpenAIBaseUrl } from './base-url.js';

describe('resolveEffectiveOpenAIBaseUrl', () => {
  it('prefers per-session config.openaiBaseUrl over ctor and env', () => {
    expect(
      resolveEffectiveOpenAIBaseUrl('https://cfg/v1', 'https://ctor/v1', 'https://env/v1'),
    ).toBe('https://cfg/v1');
  });

  it('falls back to the construction-time baseURL when config is undefined', () => {
    expect(resolveEffectiveOpenAIBaseUrl(undefined, 'https://ctor/v1', 'https://env/v1')).toBe(
      'https://ctor/v1',
    );
  });

  it('falls back to AFK_OPENAI_BASE_URL when config and ctor are undefined (the lost-base-URL fix)', () => {
    // Regression guard: a deep OpenAI-routed subagent whose child config never
    // threaded openaiBaseUrl must still reach the configured endpoint, NOT
    // api.openai.com (where a non-OpenAI key 401s as "Incorrect API key").
    expect(resolveEffectiveOpenAIBaseUrl(undefined, undefined, 'https://opencode.ai/zen/go/v1')).toBe(
      'https://opencode.ai/zen/go/v1',
    );
  });

  it('returns undefined (→ SDK default api.openai.com) when nothing is set', () => {
    expect(resolveEffectiveOpenAIBaseUrl(undefined, undefined, undefined)).toBeUndefined();
  });

  it('strips a trailing /chat/completions from the env fallback (SDK appends it)', () => {
    expect(
      resolveEffectiveOpenAIBaseUrl(undefined, undefined, 'https://x/v1/chat/completions'),
    ).toBe('https://x/v1');
  });

  it('treats a whitespace-only env value as absent', () => {
    expect(resolveEffectiveOpenAIBaseUrl(undefined, undefined, '   ')).toBeUndefined();
  });

  it('preserves an empty-string config value (parity with the prior ?? behavior)', () => {
    // The original `config.openaiBaseUrl ?? providerOpts.baseURL` kept a set-but-
    // empty config value; `!== undefined` matches that (config is never '' in
    // practice — loadConfig gates on a truthy env — but keep the semantics stable).
    expect(resolveEffectiveOpenAIBaseUrl('', 'https://ctor/v1', 'https://env/v1')).toBe('');
  });
});
