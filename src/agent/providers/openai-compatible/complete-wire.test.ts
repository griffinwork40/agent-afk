/**
 * Tests for `completeWithWire` — the wire selection behind
 * `OpenAICompatibleProvider.complete()`.
 *
 * Regression: a ChatGPT-subscription OAuth credential was always sent over
 * Chat Completions to api.openai.com (429 "no credits"), so ghost-text
 * suggestions on a gpt-* suggest model silently never appeared while
 * compaction with the same model worked. No network: auth and both one-shot
 * wires are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';

const resolveOpenAIAuth = vi.fn();
vi.mock('./auth.js', () => ({ resolveOpenAIAuth: (...a: unknown[]) => resolveOpenAIAuth(...a) }));

const oneShotChatCompletion = vi.fn(async () => 'chat-reply');
const oneShotResponses = vi.fn(async () => 'responses-reply');
vi.mock('./oneshot.js', () => ({
  oneShotChatCompletion: (...a: unknown[]) => oneShotChatCompletion(...(a as [])),
  oneShotResponses: (...a: unknown[]) => oneShotResponses(...(a as [])),
}));

import { completeWithWire, type CompleteWireClientOptions } from './complete-wire.js';
import { CHATGPT_BACKEND_BASE_URL } from './responses-config.js';

const base = { model: 'gpt-6-luna', system: 'sys', user: 'input: git sta', maxTokens: 24 };

describe('completeWithWire', () => {
  beforeEach(() => {
    resolveOpenAIAuth.mockReset();
    oneShotChatCompletion.mockClear();
    oneShotResponses.mockClear();
  });

  it('routes ChatGPT-subscription OAuth to the ChatGPT backend over Responses, never Chat Completions', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: 'chatgpt-access', source: 'chatgpt-oauth', accountId: 'acct_1' });
    const fakeClient = {} as OpenAI;
    const factory = vi.fn((_: CompleteWireClientOptions) => fakeClient);
    const signal = new AbortController().signal;

    const out = await completeWithWire({ ...base, signal }, factory);

    expect(out).toBe('responses-reply');
    expect(oneShotChatCompletion).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0]![0];
    expect(opts.apiKey).toBe('chatgpt-access');
    expect(opts.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    expect(opts.maxRetries).toBe(0);
    expect(opts.defaultHeaders).toMatchObject({ 'chatgpt-account-id': 'acct_1' });
    expect(oneShotResponses).toHaveBeenCalledWith(
      expect.objectContaining({ client: fakeClient, model: 'gpt-6-luna', isChatGptBackend: true, maxTokens: 24, signal }),
    );
  });

  it('ChatGPT backend URL wins over a caller endpoint (mirrors the live session), and caller headers are kept', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: 'chatgpt-access', source: 'chatgpt-oauth', accountId: 'acct_1' });
    const factory = vi.fn((_: CompleteWireClientOptions) => ({}) as OpenAI);

    await completeWithWire({ ...base, baseURL: 'http://localhost:8080/v1', defaultHeaders: { 'x-extra': '1' } }, factory);

    const opts = factory.mock.calls[0]![0];
    expect(opts.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    expect(opts.defaultHeaders).toMatchObject({ 'x-extra': '1', 'chatgpt-account-id': 'acct_1' });
  });

  it('keeps the API-key path on Chat Completions, handing over the resolved key and the caller endpoint', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: 'sk-platform', source: 'env' });
    const factory = vi.fn();

    const out = await completeWithWire({ ...base, baseURL: 'http://localhost:8080/v1' }, factory);

    expect(out).toBe('chat-reply');
    expect(factory).not.toHaveBeenCalled();
    expect(oneShotResponses).not.toHaveBeenCalled();
    expect(oneShotChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-platform', baseURL: 'http://localhost:8080/v1', model: 'gpt-6-luna' }),
    );
  });

  it('an explicit caller key (e.g. xAI delegation) resolves as config and stays on Chat Completions', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: 'xai-key', source: 'config' });

    await completeWithWire({ ...base, apiKey: 'xai-key', baseURL: 'https://api.x.ai/v1' });

    expect(resolveOpenAIAuth).toHaveBeenCalledWith('xai-key', {}, false);
    expect(oneShotResponses).not.toHaveBeenCalled();
    expect(oneShotChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'xai-key', baseURL: 'https://api.x.ai/v1' }),
    );
  });

  it('with no usable auth, defers to Chat Completions unchanged so its own auth error still surfaces', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: null, source: 'chatgpt-oauth-expired' });
    const input = { ...base };

    await completeWithWire(input);

    expect(oneShotResponses).not.toHaveBeenCalled();
    expect(oneShotChatCompletion).toHaveBeenCalledWith(input);
  });

  it('forwards forceChatgptOAuth to auth resolution', async () => {
    resolveOpenAIAuth.mockReturnValue({ apiKey: 'chatgpt-access', source: 'chatgpt-oauth' });

    await completeWithWire({ ...base, forceChatgptOAuth: true }, () => ({}) as OpenAI);

    expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, true);
  });
});
