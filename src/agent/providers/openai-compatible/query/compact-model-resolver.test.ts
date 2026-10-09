/**
 * Unit tests for {@link resolveOpenAICompactModel}.
 *
 * Covers the acceptance criteria from issues #3244 and #3288:
 *   1. Real OpenAI endpoint (unset baseURL, unset OPENAI_BASE_URL) + unset env → cheap default.
 *   2. Custom baseURL (local runner) + unset env → current model.
 *   3. `AFK_COMPACT_MODEL` wins in all cases (env override).
 *   4. OPENAI_BASE_URL set, opts/AFK baseURL unset → current model (regression guard).
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
  describe('real OpenAI endpoint (baseURL undefined, OPENAI_BASE_URL unset)', () => {
    it('resolves to the cheap default when AFK_COMPACT_MODEL is unset', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,          // AFK_COMPACT_MODEL unset
          undefined,          // opts.baseURL = not set
          undefined,          // OPENAI_BASE_URL = not set → real api.openai.com
          'api-key',          // auth source
          'gpt-4o',           // session model
        ),
      ).toBe(OPENAI_CHEAP_COMPACT_DEFAULT);
    });

    it('uses AFK_COMPACT_MODEL override on real OpenAI endpoint', () => {
      expect(
        resolveOpenAICompactModel(
          'gpt-4o-mini',      // explicit override
          undefined,          // opts.baseURL = not set
          undefined,          // OPENAI_BASE_URL = not set
          'api-key',
          'gpt-4o',
        ),
      ).toBe('gpt-4o-mini');
    });
  });

  describe('OPENAI_BASE_URL env var set (SDK-native env, no AFK override)', () => {
    it('falls back to current model when OPENAI_BASE_URL points at a local endpoint', () => {
      // Regression guard for #3288: OPENAI_BASE_URL set, opts.baseURL unset.
      // The SDK routes the client to the custom endpoint, so we must not send
      // gpt-6-luna to a server that only knows the session model.
      expect(
        resolveOpenAICompactModel(
          undefined,                        // AFK_COMPACT_MODEL unset
          undefined,                        // opts.baseURL (AFK_OPENAI_BASE_URL) = not set
          'http://localhost:11434/v1',       // OPENAI_BASE_URL → local Ollama/etc.
          'api-key',
          'llama3',
        ),
      ).toBe('llama3');
    });

    it('falls back to current model for a proxy via OPENAI_BASE_URL', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,
          undefined,
          'https://my-proxy.example.com/v1',
          'api-key',
          'gpt-4o',
        ),
      ).toBe('gpt-4o');
    });
  });

  describe('custom baseURL (local runner / proxy via opts.baseURL)', () => {
    it('falls back to current model when AFK_COMPACT_MODEL is unset', () => {
      expect(
        resolveOpenAICompactModel(
          undefined,
          'http://localhost:8080/v1',  // local runner
          undefined,
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
          undefined,
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
          undefined,
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
          undefined,
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
          undefined,          // opts.baseURL unset, but chatgpt-oauth route
          undefined,
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
          undefined,
          'chatgpt-oauth',
          'gpt-4o',
        ),
      ).toBe('gpt-4.1-nano');
    });
  });

  describe('AFK_COMPACT_MODEL override wins in all cases', () => {
    const cases = [
      { desc: 'real OpenAI + api-key', baseURL: undefined, openaiBaseUrlEnv: undefined, authSource: 'api-key', current: 'gpt-4o' },
      { desc: 'local runner via opts.baseURL', baseURL: 'http://localhost:8080/v1', openaiBaseUrlEnv: undefined, authSource: 'api-key', current: 'llama3' },
      { desc: 'local runner via OPENAI_BASE_URL', baseURL: undefined, openaiBaseUrlEnv: 'http://localhost:8080/v1', authSource: 'api-key', current: 'llama3' },
      { desc: 'chatgpt-oauth', baseURL: undefined, openaiBaseUrlEnv: undefined, authSource: 'chatgpt-oauth', current: 'gpt-4o' },
    ] as const;

    for (const { desc, baseURL, openaiBaseUrlEnv, authSource, current } of cases) {
      it(`AFK_COMPACT_MODEL overrides for ${desc}`, () => {
        expect(
          resolveOpenAICompactModel('custom-model-x', baseURL as string | undefined, openaiBaseUrlEnv as string | undefined, authSource, current),
        ).toBe('custom-model-x');
      });
    }
  });

  describe('edge cases', () => {
    it('treats empty string AFK_COMPACT_MODEL as unset (falls through to default)', () => {
      // Empty string is falsy for our guard — treated same as unset.
      expect(
        resolveOpenAICompactModel('', undefined, undefined, 'api-key', 'gpt-4o'),
      ).toBe(OPENAI_CHEAP_COMPACT_DEFAULT);
    });

    it('OPENAI_CHEAP_COMPACT_DEFAULT is gpt-6-luna', () => {
      // Pin the constant so a rename is a test failure (not a silent drift).
      expect(OPENAI_CHEAP_COMPACT_DEFAULT).toBe('gpt-6-luna');
    });
  });
});
