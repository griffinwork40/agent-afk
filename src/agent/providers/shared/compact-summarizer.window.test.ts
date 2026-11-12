/**
 * Tests for `resolveSummarizerWindow`: the one place that decides which
 * context window sizes the compaction summarizer input. It must agree with the
 * route `resolveCrossProviderSummarize` takes, so each case also checks that
 * routing outcome. Auth and slot bindings are stubbed: no real credentials and
 * no local config files are read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const authMode = vi.hoisted(() => ({ ambient: 'env' as 'env' | 'chatgpt-oauth' }));

vi.mock('../openai-compatible/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../openai-compatible/auth.js')>()),
  resolveOpenAIAuth: vi.fn((_key: string | undefined, _deps: unknown, force?: boolean) =>
    force || authMode.ambient === 'chatgpt-oauth'
      ? { apiKey: 'oauth-token', source: 'chatgpt-oauth', accountId: 'acct' }
      : { apiKey: 'sk-test', source: 'env' }),
}));

vi.mock('../../session/model-slots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/model-slots.js')>()),
  resolveBinding: (input: string | undefined) => {
    if (input === 'sub-slot') return { id: 'gpt-6-luna', provider: 'chatgpt-oauth' };
    if (input === 'proxy-slot') return { id: 'gpt-6-luna', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' };
    return { id: input ?? '' };
  },
}));

import { resolveCrossProviderSummarize, resolveSummarizerWindow } from './compact-summarizer.js';

const SESSION_OAUTH = { model: 'gpt-5.5', subscriptionPath: true };
const SESSION_KEY = { model: 'gpt-6-luna', subscriptionPath: false };
const SESSION_ANTHROPIC = { model: 'claude-haiku-4-5-20251001', subscriptionPath: false };

function routesToSession(family: 'openai-compatible' | 'anthropic-direct', raw: string | undefined): boolean {
  const own = async (): Promise<string> => 'own';
  return resolveCrossProviderSummarize(family, own, raw, {}) === own;
}

beforeEach(() => {
  authMode.ambient = 'env';
  vi.stubEnv('AFK_PROVIDER', undefined);
  vi.stubEnv('AFK_OPENAI_BASE_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveSummarizerWindow', () => {
  it('API-key session, no compact model: the session window as stated by the caller', () => {
    expect(resolveSummarizerWindow('openai-compatible', undefined, SESSION_KEY)).toEqual(SESSION_KEY);
    expect(routesToSession('openai-compatible', undefined)).toBe(true);
  });

  it('chatgpt-oauth session, no compact model: keeps the subscription catalog', () => {
    expect(resolveSummarizerWindow('openai-compatible', '', SESSION_OAUTH)).toEqual(SESSION_OAUTH);
  });

  it('chatgpt-oauth session, same-family compact model: the session connection sends it, so the subscription catalog still applies', () => {
    const session = { model: 'gpt-6-luna', subscriptionPath: true };
    expect(resolveSummarizerWindow('openai-compatible', 'gpt-6-luna', session)).toEqual(session);
    expect(routesToSession('openai-compatible', 'gpt-6-luna')).toBe(true);
  });

  it('foreign Anthropic target: the target model, never the subscription catalog', () => {
    expect(resolveSummarizerWindow('openai-compatible', 'claude-haiku-4-5-20251001', SESSION_OAUTH)).toEqual({
      model: 'claude-haiku-4-5-20251001',
      subscriptionPath: false,
    });
    expect(routesToSession('openai-compatible', 'claude-haiku-4-5-20251001')).toBe(false);
  });

  it('foreign OpenAI target on an API key: the target model on the API-tier table', () => {
    expect(resolveSummarizerWindow('anthropic-direct', 'gpt-6-luna', SESSION_ANTHROPIC)).toEqual({
      model: 'gpt-6-luna',
      subscriptionPath: false,
    });
    expect(routesToSession('anthropic-direct', 'gpt-6-luna')).toBe(false);
  });

  it('foreign OpenAI target resolving to ambient chatgpt-oauth: the subscription catalog', () => {
    authMode.ambient = 'chatgpt-oauth';
    expect(resolveSummarizerWindow('anthropic-direct', 'gpt-6-luna', SESSION_ANTHROPIC)).toEqual({
      model: 'gpt-6-luna',
      subscriptionPath: true,
    });
  });

  it('foreign slot bound to chatgpt-oauth: the bound model on the subscription catalog', () => {
    expect(resolveSummarizerWindow('anthropic-direct', 'sub-slot', SESSION_ANTHROPIC)).toEqual({
      model: 'gpt-6-luna',
      subscriptionPath: true,
    });
  });

  it('foreign chatgpt-oauth credential on a custom endpoint: not the ChatGPT backend, so the API-tier table', () => {
    authMode.ambient = 'chatgpt-oauth';
    expect(resolveSummarizerWindow('anthropic-direct', 'proxy-slot', SESSION_ANTHROPIC)).toEqual({
      model: 'gpt-6-luna',
      subscriptionPath: false,
    });
  });
});
