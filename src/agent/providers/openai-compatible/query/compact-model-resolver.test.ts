/**
 * Unit tests for {@link resolveOpenAICompactModel}.
 *
 * Covers the three acceptance criteria from issue #3244:
 *   1. Real OpenAI endpoint (unset baseURL) + unset env → cheap default.
 *   2. Custom baseURL (local runner) + unset env → current model.
 *   3. `AFK_COMPACT_MODEL` wins in both cases (env override).
 *
 * Plus: ChatGPT-subscription (chatgpt-oauth) falls back to current model.
 *
 * @module agent/providers/openai-compatible/query/compact-model-resolver.test
 */
import { describe, it, expect } from 'vitest';
import {
  resolveOpenAICompactModel,
  OPENAI_CHEAP_COMPACT_DEFAULT,
} from './compact-model-resolver.js';

describe('resolveOpenAICompactModel', () => {
  describe('real OpenAI endpoint (baseURL undefined)', () => {
    it('resolves to the cheap default when AFK_COMPACT_MODEL is unset', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,          // AFK_COMPACT_MODEL unset
          undefined,          // baseURL = real OpenAI
          'api-key',          // auth source
          'gpt-4o',           // session model
        ),
      ).toBe(OPENAI_CHEAP_COMPACT_DEFAULT);
    });

    it('uses AFK_COMPACT_MODEL override on real OpenAI endpoint', () => {
      expect(
        resolveOpenAICompactModel(
          'gpt-4o-mini',      // explicit override
          undefined,          // baseURL = real OpenAI
          'api-key',
          'gpt-4o',
        ),
      ).toBe('gpt-4o-mini');
    });
  });

  describe('custom baseURL (local runner / proxy)', () => {
    it('falls back to current model when AFK_COMPACT_MODEL is unset', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,
          'http://localhost:8080/v1',  // local runner
          'api-key',
          'llama3',
        ),
      ).toBe('llama3');
    });

    it('uses AFK_COMPACT_MODEL override on custom baseURL', () => {
      expect(
        resolveOpenAICompactModel(
          'gpt-4.1-mini',
          'http://localhost:8080/v1',
          'api-key',
          'llama3',
        ),
      ).toBe('gpt-4.1-mini');
    });

    it('falls back to current model for ollama-style endpoint', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,
          'http://localhost:11434/v1',
          'api-key',
          'mistral',
        ),
      ).toBe('mistral');
    });

    it('falls back to current model for vLLM-style endpoint', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,
          'https://my-vllm-server.example.com/v1',
          'api-key',
          'meta-llama/Meta-Llama-3.1-70B-Instruct',
        ),
      ).toBe('meta-llama/Meta-Llama-3.1-70B-Instruct');
    });
  });

  describe('ChatGPT-subscription (chatgpt-oauth)', () => {
    it('falls back to current model regardless of baseURL', () => {
      // The ChatGPT backend may not serve cheap API models; keep current model.
      expect(
        resolveOpenAICompactModel(
          undefined,
          undefined,          // baseURL unset, but chatgpt-oauth route
          'chatgpt-oauth',
          'gpt-4o',
        ),
      ).toBe('gpt-4o');
    });

    it('uses AFK_COMPACT_MODEL override for chatgpt-oauth', () => {
      expect(
        resolveOpenAICompactModel(
          'gpt-4.1-nano',
          undefined,
          'chatgpt-oauth',
          'gpt-4o',
        ),
      ).toBe('gpt-4.1-nano');
    });
  });

  describe('AFK_COMPACT_MODEL override wins in all cases', () => {
    const cases = [
      { desc: 'real OpenAI + api-key', baseURL: undefined, authSource: 'api-key', current: 'gpt-4o' },
      { desc: 'local runner', baseURL: 'http://localhost:8080/v1', authSource: 'api-key', current: 'llama3' },
      { desc: 'chatgpt-oauth', baseURL: undefined, authSource: 'chatgpt-oauth', current: 'gpt-4o' },
    ] as const;

    for (const { desc, baseURL, authSource, current } of cases) {
      it(`AFK_COMPACT_MODEL overrides for ${desc}`, () => {
        expect(
          resolveOpenAICompactModel('custom-model-x', baseURL as string | undefined, authSource, current),
        ).toBe('custom-model-x');
      });
    }
  });

  describe('edge cases', () => {
    it('treats empty string AFK_COMPACT_MODEL as unset (falls through to default)', () => {
      // Empty string is falsy for our guard — treated same as unset.
      expect(
        resolveOpenAICompactModel('', undefined, 'api-key', 'gpt-4o'),
      ).toBe(OPENAI_CHEAP_COMPACT_DEFAULT);
    });

    it('OPENAI_CHEAP_COMPACT_DEFAULT is gpt-6-luna', () => {
      // Pin the constant so a rename is a test failure (not a silent drift).
      expect(OPENAI_CHEAP_COMPACT_DEFAULT).toBe('gpt-6-luna');
    });
  });
});
