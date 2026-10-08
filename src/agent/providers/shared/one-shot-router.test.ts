import { afterEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn(async () => ({ text: 'chat reply', stopReason: 'end' as const }));
vi.mock('../openai-compatible/oneshot.js', () => ({
  oneShotChatCompletionWithStop: (...args: unknown[]) => chat(...(args as [])),
  oneShotResponses: vi.fn(),
}));

import { resolveOneShotTarget, routedOneShot, routedOneShotWithStop } from './one-shot-router.js';
import {
  CLAUDE_OPUS_ID,
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
} from '../../session/model-slots.js';

afterEach(() => {
  resetSlotBindings();
  chat.mockClear();
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
