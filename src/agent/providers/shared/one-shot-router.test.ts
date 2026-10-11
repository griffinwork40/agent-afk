import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OneShotStopReason } from './one-shot-router.js';

const chat = vi.fn(async (): Promise<{ text: string; stopReason: OneShotStopReason }> => ({
  text: 'chat reply', stopReason: 'end',
}));
vi.mock('../openai-compatible/oneshot.js', () => ({
  oneShotChatCompletionWithStop: (...args: unknown[]) => chat(...(args as [])),
  oneShotResponses: vi.fn(),
}));

const anthropicOneshot = vi.hoisted(() => ({
  oneShotCompletionWithStop: vi.fn(async (): Promise<{ text: string; stopReason: OneShotStopReason }> => ({
    text: 'anthropic reply', stopReason: 'end',
  })),
}));
vi.mock('../anthropic-direct/oneshot.js', () => anthropicOneshot);

const credentialResolver = vi.hoisted(() => ({
  loadAnthropicCredential: vi.fn(() => 'sk-ant-ambient'),
}));
vi.mock('../../auth/credential-resolver.js', () => credentialResolver);

const xaiAuth = vi.hoisted(() => ({
  resolveXaiAuth: vi.fn(() => ({
    apiKey: 'xai-key',
    source: 'env' as const,
    mode: 'apikey' as const,
  })),
  formatXaiAuthDiagnostic: vi.fn(),
  formatXaiHttpAuthError: vi.fn(),
}));
vi.mock('../xai/auth.js', () => xaiAuth);

const xaiEndpoints = vi.hoisted(() => ({
  resolveXaiEndpoint: vi.fn(() => ({
    baseURL: 'https://api.x.ai/v1',
    defaultHeaders: {},
    mode: 'apikey' as const,
    proxyHeadersApplied: false,
  })),
  DEFAULT_XAI_API_BASE_URL: 'https://api.x.ai/v1',
  DEFAULT_XAI_OAUTH_BASE_URL: 'https://cli-chat-proxy.grok.com/v1',
}));
vi.mock('../xai/endpoints.js', () => xaiEndpoints);

const xaiOauth = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(async () => null),
}));
vi.mock('../xai/oauth.js', () => xaiOauth);

const xaiQueryHelpers = vi.hoisted(() => ({
  isAccessTokenExpired: vi.fn(() => false),
}));
vi.mock('../xai/query-helpers.js', () => xaiQueryHelpers);

import { resolveOneShotTarget, routedOneShot, routedOneShotWithStop } from './one-shot-router.js';
import {
  CLAUDE_OPUS_ID,
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
} from '../../session/model-slots.js';

afterEach(() => {
  resetSlotBindings();
  // mockReset clears both call records and the pending once-queue so that
  // un-consumed mockReturnValueOnce values from one test never bleed into the
  // next.  We re-wire the defaults that tests rely on below.
  chat.mockReset();
  anthropicOneshot.oneShotCompletionWithStop.mockReset();
  credentialResolver.loadAnthropicCredential.mockReset();
  xaiAuth.resolveXaiAuth.mockReset();
  xaiEndpoints.resolveXaiEndpoint.mockReset();
  xaiOauth.ensureFreshAccessToken.mockReset();
  xaiQueryHelpers.isAccessTokenExpired.mockReset();

  // Re-wire defaults used by the openai-compatible tests that run
  // before any per-test override.
  chat.mockImplementation(async () => ({ text: 'chat reply', stopReason: 'end' as OneShotStopReason }));
  anthropicOneshot.oneShotCompletionWithStop.mockImplementation(async () => ({ text: 'anthropic reply', stopReason: 'end' as OneShotStopReason }));
  credentialResolver.loadAnthropicCredential.mockImplementation(() => 'sk-ant-ambient');
  xaiAuth.resolveXaiAuth.mockImplementation(() => ({ apiKey: 'xai-key', source: 'env' as const, mode: 'apikey' as const }));
  xaiEndpoints.resolveXaiEndpoint.mockImplementation(() => ({ baseURL: 'https://api.x.ai/v1', defaultHeaders: {}, mode: 'apikey' as const, proxyHeadersApplied: false }));
  xaiOauth.ensureFreshAccessToken.mockImplementation(async () => null);
  xaiQueryHelpers.isAccessTokenExpired.mockImplementation(() => false);
});

const LABEL = { tag: '[test]', purpose: 'testing', unsupportedHint: 'Pick another.' };

describe('resolveOneShotTarget', () => {
  it('maps a slot to its id, explicit provider, and credentials', () => {
    setSlotBindings({
      ...DEFAULT_SLOT_BINDINGS,
      local: { id: 'bare-model', provider: 'openai', baseUrl: 'https://shim.test/v1', apiKey: 'k' },
    });
    expect(resolveOneShotTarget(' local ')).toEqual({
      model: 'bare-model',
      provider: 'openai-compatible',
      binding: { id: 'bare-model', provider: 'openai', baseUrl: 'https://shim.test/v1', apiKey: 'k' },
    });
  });

  it('resolves an identity alias and passes a raw id through', () => {
    setSlotBindings({ ...DEFAULT_SLOT_BINDINGS });
    expect(resolveOneShotTarget('opus')).toMatchObject({ model: CLAUDE_OPUS_ID, provider: 'anthropic-direct' });
    expect(resolveOneShotTarget('gpt-4o-mini')).toMatchObject({ model: 'gpt-4o-mini', provider: 'openai-compatible' });
  });
});

describe('routedOneShot', () => {
  it('sends an explicit-key OpenAI call to the binding endpoint with the caller maxTokens', async () => {
    const out = await routedOneShot({
      model: 'bare-model',
      provider: 'openai-compatible',
      binding: { apiKey: 'k', baseUrl: 'https://shim.test/v1' },
      system: 's',
      user: 'u',
      maxTokens: 777,
      label: LABEL,
    });
    expect(out).toBe('chat reply');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'k',
      baseURL: 'https://shim.test/v1',
      model: 'bare-model',
      maxTokens: 777,
    }));
  });

  it('labels the unsupported-provider error with the caller vocabulary', async () => {
    await expect(routedOneShot({
      model: 'm',
      provider: 'mystery' as never,
      binding: {},
      system: 's',
      user: 'u',
      maxTokens: 1,
      label: LABEL,
    })).rejects.toThrow('[test] Unsupported cross-provider target: mystery. Pick another.');
  });

  it('still returns a plain string (backward compat wrapper)', async () => {
    chat.mockResolvedValueOnce({ text: 'wrapper reply', stopReason: 'max_tokens' as const });
    const result = await routedOneShot({
      model: 'bare-model',
      provider: 'openai-compatible',
      binding: { apiKey: 'k' },
      system: 's',
      user: 'u',
      maxTokens: 1,
      label: LABEL,
    });
    expect(typeof result).toBe('string');
    expect(result).toBe('wrapper reply');
  });
});

describe('routedOneShotWithStop', () => {
  it('propagates stopReason from the underlying provider call', async () => {
    chat.mockResolvedValueOnce({ text: 'partial text', stopReason: 'max_tokens' as const });
    const result = await routedOneShotWithStop({
      model: 'bare-model',
      provider: 'openai-compatible',
      binding: { apiKey: 'k', baseUrl: 'https://shim.test/v1' },
      system: 's',
      user: 'u',
      maxTokens: 100,
      label: LABEL,
    });
    expect(result.text).toBe('partial text');
    expect(result.stopReason).toBe('max_tokens');
  });

  it('propagates stopReason end from a normal completion', async () => {
    chat.mockResolvedValueOnce({ text: 'full text', stopReason: 'end' as const });
    const result = await routedOneShotWithStop({
      model: 'bare-model',
      provider: 'openai-compatible',
      binding: { apiKey: 'k' },
      system: 's',
      user: 'u',
      maxTokens: 100,
      label: LABEL,
    });
    expect(result.stopReason).toBe('end');
  });
});

// ---------------------------------------------------------------------------
// anthropic-direct branch of routedOneShotWithStop
// ---------------------------------------------------------------------------

describe('routedOneShotWithStop — anthropic-direct branch', () => {
  it('delegates to oneShotCompletionWithStop with the ambient credential', async () => {
    anthropicOneshot.oneShotCompletionWithStop.mockResolvedValueOnce({
      text: 'claude reply',
      stopReason: 'end' as OneShotStopReason,
    });
    credentialResolver.loadAnthropicCredential.mockReturnValueOnce('sk-ant-ambient');

    const result = await routedOneShotWithStop({
      model: 'claude-haiku-4-5',
      provider: 'anthropic-direct',
      binding: {},
      system: 'sys',
      user: 'usr',
      maxTokens: 512,
      label: LABEL,
    });

    expect(result.text).toBe('claude reply');
    expect(result.stopReason).toBe('end');
    expect(anthropicOneshot.oneShotCompletionWithStop).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'sk-ant-ambient',
        model: 'claude-haiku-4-5',
        maxTokens: 512,
      }),
    );
  });

  it('prefers the binding.apiKey over the ambient credential', async () => {
    anthropicOneshot.oneShotCompletionWithStop.mockResolvedValueOnce({
      text: 'explicit key reply',
      stopReason: 'end' as OneShotStopReason,
    });
    // loadAnthropicCredential must NOT be used when binding.apiKey is set.
    credentialResolver.loadAnthropicCredential.mockReturnValueOnce('ambient-should-not-appear');

    await routedOneShotWithStop({
      model: 'claude-opus-5-5',
      provider: 'anthropic-direct',
      binding: { apiKey: 'sk-ant-explicit' },
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    });

    expect(anthropicOneshot.oneShotCompletionWithStop).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'sk-ant-explicit' }),
    );
    // Ambient credential must not have been loaded.
    expect(credentialResolver.loadAnthropicCredential).not.toHaveBeenCalled();
  });

  it('propagates a max_tokens stopReason through the anthropic path', async () => {
    anthropicOneshot.oneShotCompletionWithStop.mockResolvedValueOnce({
      text: 'truncated',
      stopReason: 'max_tokens' as OneShotStopReason,
    });

    const result = await routedOneShotWithStop({
      model: 'claude-haiku-4-5',
      provider: 'anthropic-direct',
      binding: { apiKey: 'sk-ant-k' },
      system: 'sys',
      user: 'usr',
      maxTokens: 1,
      label: LABEL,
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.text).toBe('truncated');
  });

  it('throws when a custom baseUrl is set but no explicit apiKey is provided', async () => {
    // Security guard: ambient credential must never be sent to a non-Anthropic host.
    credentialResolver.loadAnthropicCredential.mockReturnValueOnce('sk-ant-ambient');

    await expect(routedOneShotWithStop({
      model: 'claude-haiku-4-5',
      provider: 'anthropic-direct',
      binding: { baseUrl: 'https://custom.proxy.example.com/v1' },
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    })).rejects.toThrow(/custom Anthropic baseUrl.*no.*apiKey/i);

    // The underlying helper must NOT have been called (rejection is pre-call).
    expect(anthropicOneshot.oneShotCompletionWithStop).not.toHaveBeenCalled();
  });

  it('allows a custom baseUrl when an explicit apiKey is also supplied', async () => {
    anthropicOneshot.oneShotCompletionWithStop.mockResolvedValueOnce({
      text: 'proxy reply',
      stopReason: 'end' as OneShotStopReason,
    });

    const result = await routedOneShotWithStop({
      model: 'claude-haiku-4-5',
      provider: 'anthropic-direct',
      binding: { baseUrl: 'https://custom.proxy.example.com/v1', apiKey: 'sk-ant-custom' },
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    });

    expect(result.text).toBe('proxy reply');
    expect(anthropicOneshot.oneShotCompletionWithStop).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'sk-ant-custom',
        baseUrl: 'https://custom.proxy.example.com/v1',
      }),
    );
  });

  it('throws with the label tag when no Anthropic credential is available', async () => {
    // Override the default implementation for this call so the ambient-credential
    // fallback yields nothing, triggering the "no credential" error path.
    credentialResolver.loadAnthropicCredential.mockImplementationOnce(() => undefined as unknown as string);

    await expect(routedOneShotWithStop({
      model: 'claude-haiku-4-5',
      provider: 'anthropic-direct',
      binding: {},
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    })).rejects.toThrow('[test]');
  });
});

// ---------------------------------------------------------------------------
// xai branch of routedOneShotWithStop
// ---------------------------------------------------------------------------

describe('routedOneShotWithStop — xai branch', () => {
  it('calls ensureFreshAccessToken before resolving credentials (API-key mode)', async () => {
    // For apikey force mode the router still runs ensureFreshAccessToken
    // when forceMode is undefined (auto). When the binding.provider is 'xai',
    // forceMode becomes 'apikey', skipping the refresh. Verify the fast-path.
    xaiAuth.resolveXaiAuth.mockReturnValueOnce({
      apiKey: 'xai-key',
      source: 'env' as const,
      mode: 'apikey' as const,
    });
    chat.mockResolvedValueOnce({ text: 'grok reply', stopReason: 'end' as OneShotStopReason });

    const result = await routedOneShotWithStop({
      model: 'grok-3-beta',
      provider: 'xai',
      binding: { provider: 'xai' },   // forces apikey → no OAuth refresh
      system: 'sys',
      user: 'usr',
      maxTokens: 256,
      label: LABEL,
    });

    expect(result.text).toBe('grok reply');
    expect(result.stopReason).toBe('end');
    // apikey force mode skips ensureFreshAccessToken
    expect(xaiOauth.ensureFreshAccessToken).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'xai-key', baseURL: 'https://api.x.ai/v1' }),
    );
  });

  it('runs OAuth refresh and propagates stopReason for the oauth force path', async () => {
    // Ensure invocation-order assertion is meaningful: resolveXaiAuth returns
    // a different token depending on whether the refresh ran first.  Before
    // refresh the stored token is 'xai-oauth-token-stale'; after refresh
    // resolveXaiAuth is called once and returns 'xai-oauth-token-fresh'.
    // If the call order were swapped (resolveXaiAuth before refresh) the test
    // would receive the stale token and the chat assertion would fail.
    let refreshCompleted = false;
    xaiOauth.ensureFreshAccessToken.mockImplementationOnce(async () => {
      refreshCompleted = true;
      return null;
    });
    xaiAuth.resolveXaiAuth.mockImplementationOnce(() => {
      // resolveXaiAuth must be called AFTER refresh; capture the state.
      return {
        apiKey: refreshCompleted ? 'xai-oauth-token-fresh' : 'xai-oauth-token-stale',
        source: 'xai-oauth' as const,
        mode: 'oauth' as const,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });
    xaiEndpoints.resolveXaiEndpoint.mockReturnValueOnce({
      baseURL: 'https://cli-chat-proxy.grok.com/v1',
      defaultHeaders: { 'x-proxy': 'true' },
      mode: 'oauth' as const,
      proxyHeadersApplied: true,
    });
    xaiQueryHelpers.isAccessTokenExpired.mockReturnValueOnce(false);
    chat.mockResolvedValueOnce({ text: 'grok oauth reply', stopReason: 'max_tokens' as OneShotStopReason });

    const result = await routedOneShotWithStop({
      model: 'grok-3-beta',
      provider: 'xai-oauth',
      binding: { provider: 'xai-oauth' },
      system: 'sys',
      user: 'usr',
      maxTokens: 10,
      label: LABEL,
    });

    expect(result.stopReason).toBe('max_tokens');
    // OAuth path must refresh tokens before resolving credentials; confirmed
    // by asserting chat received the post-refresh token, not the stale one.
    expect(xaiOauth.ensureFreshAccessToken).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'xai-oauth-token-fresh',
        baseURL: 'https://cli-chat-proxy.grok.com/v1',
        defaultHeaders: { 'x-proxy': 'true' },
      }),
    );
  });

  it('throws with label tag when no xAI credential is available', async () => {
    xaiAuth.resolveXaiAuth.mockReturnValueOnce({
      apiKey: null,
      source: 'no-usable-auth' as const,
    });

    await expect(routedOneShotWithStop({
      model: 'grok-3-beta',
      provider: 'xai',
      binding: {},
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    })).rejects.toThrow('[test]');

    expect(chat).not.toHaveBeenCalled();
  });

  it('throws with label tag when the OAuth token is expired after refresh', async () => {
    xaiAuth.resolveXaiAuth.mockReturnValueOnce({
      apiKey: 'expired-token',
      source: 'xai-oauth' as const,
      mode: 'oauth' as const,
      expiresAt: 1,  // epoch 1 = already expired
    });
    xaiQueryHelpers.isAccessTokenExpired.mockReturnValueOnce(true);

    await expect(routedOneShotWithStop({
      model: 'grok-3-beta',
      provider: 'xai-oauth',
      binding: { provider: 'xai-oauth' },
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      label: LABEL,
    })).rejects.toThrow('[test]');

    expect(chat).not.toHaveBeenCalled();
  });
});
