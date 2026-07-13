/**
 * Tests for `modelAvailability` / `isModelAvailable`.
 *
 * Mocks the two credential sources (`credential-resolver.ts`,
 * `openai-compatible/auth.ts`) and `providerForModel` for determinism, and
 * drives `resolveBinding` with explicit `bindings` tables rather than the
 * process-global singleton.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadAnthropicCredential = vi.fn<[], string | undefined>();
const loadOpenAICredential = vi.fn<[], string | undefined>();
const resolveOpenAIAuth = vi.fn();
const providerForModel = vi.fn<[string | undefined], string>();

vi.mock('./credential-resolver.js', () => ({
  loadAnthropicCredential: (...args: unknown[]) => loadAnthropicCredential(...(args as [])),
  loadOpenAICredential: (...args: unknown[]) => loadOpenAICredential(...(args as [])),
}));

vi.mock('../providers/openai-compatible/auth.js', () => ({
  resolveOpenAIAuth: (...args: unknown[]) => resolveOpenAIAuth(...args),
}));

vi.mock('../providers/index.js', () => ({
  providerForModel: (...args: [string | undefined]) => providerForModel(...args),
}));

import { modelAvailability, isModelAvailable } from './model-availability.js';
import type { ModelSlots, ModelSlotBinding } from '../session/model-slots.js';

function slots(overrides: Partial<Record<keyof ModelSlots, ModelSlotBinding>> = {}): ModelSlots {
  const base: ModelSlots = {
    local: { id: '' },
    small: { id: 'claude-haiku-4-5-20251001' },
    medium: { id: 'claude-sonnet-5' },
    large: { id: 'claude-opus-4-8' },
  };
  return { ...base, ...overrides } as ModelSlots;
}

describe('modelAvailability', () => {
  beforeEach(() => {
    loadAnthropicCredential.mockReset();
    loadOpenAICredential.mockReset();
    resolveOpenAIAuth.mockReset();
    providerForModel.mockReset();
    providerForModel.mockReturnValue('anthropic-direct');
  });

  it('treats undefined model as available/unknown', () => {
    expect(modelAvailability(undefined)).toEqual({ available: true, needs: 'unknown' });
  });

  it('treats the "auto" sentinel (any case/whitespace) as available/unknown', () => {
    expect(modelAvailability('auto')).toEqual({ available: true, needs: 'unknown' });
    expect(modelAvailability(' AUTO ')).toEqual({ available: true, needs: 'unknown' });
  });

  describe('anthropic-direct tiers (sonnet/opus/haiku)', () => {
    it('is available when loadAnthropicCredential returns a value', () => {
      loadAnthropicCredential.mockReturnValue('sk-ant-xxx');
      const result = modelAvailability('sonnet', slots());
      expect(result.available).toBe(true);
      expect(result.needs).toBe('anthropic');
      expect(result.hint).toBeUndefined();
    });

    it('is unavailable with a hint when loadAnthropicCredential returns undefined', () => {
      loadAnthropicCredential.mockReturnValue(undefined);
      const result = modelAvailability('opus', slots());
      expect(result).toEqual({
        available: false,
        needs: 'anthropic',
        hint: 'needs Claude sign-in / ANTHROPIC_API_KEY',
      });
    });

    it('checks haiku the same way', () => {
      loadAnthropicCredential.mockReturnValue('sk-ant-xxx');
      expect(modelAvailability('haiku', slots()).available).toBe(true);
      loadAnthropicCredential.mockReturnValue(undefined);
      expect(modelAvailability('haiku', slots()).available).toBe(false);
    });
  });

  describe('chatgpt-oauth-bound tier', () => {
    it('is available when resolveOpenAIAuth(undefined, {}, true).apiKey is non-null', () => {
      resolveOpenAIAuth.mockReturnValue({ apiKey: 'chatgpt-token', source: 'chatgpt-oauth' });
      const bindings = slots({ medium: { id: 'gpt-5', provider: 'chatgpt-oauth' } });
      const result = modelAvailability('medium', bindings);
      expect(result).toEqual({ available: true, needs: 'chatgpt-oauth' });
      expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, true);
    });

    it('is unavailable with a hint when no ChatGPT OAuth token is found', () => {
      resolveOpenAIAuth.mockReturnValue({ apiKey: null, source: 'no-usable-auth-forced-chatgpt-oauth' });
      const bindings = slots({ medium: { id: 'gpt-5', provider: 'chatgpt-oauth' } });
      const result = modelAvailability('medium', bindings);
      expect(result).toEqual({
        available: false,
        needs: 'chatgpt-oauth',
        hint: 'needs ChatGPT sign-in (~/.codex/auth.json)',
      });
    });

    it('does NOT let a per-slot apiKey mask a missing ChatGPT OAuth token', () => {
      // Runtime forces the OAuth path for a chatgpt-oauth slot and ignores any
      // per-slot/explicit key (resolveOpenAIAuth(..., true) reads ~/.codex only),
      // so a stale per-slot key must not short-circuit to "available" here.
      resolveOpenAIAuth.mockReturnValue({ apiKey: null, source: 'no-usable-auth-forced-chatgpt-oauth' });
      const bindings = slots({ medium: { id: 'gpt-5', provider: 'chatgpt-oauth', apiKey: 'preset' } });
      const result = modelAvailability('medium', bindings);
      expect(result).toEqual({
        available: false,
        needs: 'chatgpt-oauth',
        hint: 'needs ChatGPT sign-in (~/.codex/auth.json)',
      });
      expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, true);
    });

    it('is available when a chatgpt-oauth slot with a per-slot key also has a resolvable OAuth token', () => {
      resolveOpenAIAuth.mockReturnValue({ apiKey: 'chatgpt-token', source: 'chatgpt-oauth' });
      const bindings = slots({ medium: { id: 'gpt-5', provider: 'chatgpt-oauth', apiKey: 'preset' } });
      const result = modelAvailability('medium', bindings);
      expect(result).toEqual({ available: true, needs: 'chatgpt-oauth' });
      expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, true);
    });
  });

  describe('plain openai tier', () => {
    beforeEach(() => {
      providerForModel.mockReturnValue('openai-compatible');
    });

    it('is available when loadOpenAICredential returns a value', () => {
      loadOpenAICredential.mockReturnValue('sk-openai-xxx');
      const bindings = slots({ small: { id: 'gpt-4o-mini' } });
      const result = modelAvailability('small', bindings);
      expect(result).toEqual({ available: true, needs: 'openai' });
    });

    it('falls back to resolveOpenAIAuth(undefined, {}, false) when no direct env credential', () => {
      loadOpenAICredential.mockReturnValue(undefined);
      resolveOpenAIAuth.mockReturnValue({ apiKey: 'from-codex-cli', source: 'codex-cli' });
      const bindings = slots({ small: { id: 'gpt-4o-mini' } });
      const result = modelAvailability('small', bindings);
      expect(result.available).toBe(true);
      expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, false);
    });

    it('is unavailable with a hint when neither source has a key', () => {
      loadOpenAICredential.mockReturnValue(undefined);
      resolveOpenAIAuth.mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
      const bindings = slots({ small: { id: 'gpt-4o-mini' } });
      const result = modelAvailability('small', bindings);
      expect(result).toEqual({ available: false, needs: 'openai', hint: 'needs OPENAI_API_KEY' });
    });

    it('treats a custom baseUrl endpoint as always available (conservative — key requirement unknowable)', () => {
      const bindings = slots({ small: { id: 'local-model', baseUrl: 'http://localhost:8080/v1' } });
      const result = modelAvailability('small', bindings);
      expect(result).toEqual({ available: true, needs: 'local' });
      expect(loadOpenAICredential).not.toHaveBeenCalled();
      expect(resolveOpenAIAuth).not.toHaveBeenCalled();
    });

    it('short-circuits to available/unknown on a per-slot apiKey (non-oauth), skipping credential resolution', () => {
      const bindings = slots({ small: { id: 'gpt-4o-mini', apiKey: 'sk-preset' } });
      const result = modelAvailability('small', bindings);
      expect(result).toEqual({ available: true, needs: 'unknown' });
      expect(loadOpenAICredential).not.toHaveBeenCalled();
      expect(resolveOpenAIAuth).not.toHaveBeenCalled();
    });
  });

  describe('empty local slot', () => {
    it('is unavailable with a "not configured" hint', () => {
      const result = modelAvailability('local', slots());
      expect(result).toEqual({
        available: false,
        needs: 'local',
        hint: 'not configured (set AFK_MODEL_LOCAL / models.local)',
      });
    });
  });

  describe('unrecognized provider shapes', () => {
    it('defaults to available/unknown for a provider that is neither anthropic-direct nor openai-compatible', () => {
      providerForModel.mockReturnValue('something-else');
      const bindings = slots({ small: { id: 'mystery-model' } });
      const result = modelAvailability('small', bindings);
      expect(result).toEqual({ available: true, needs: 'unknown' });
    });
  });

  describe('conservative fallback on internal errors', () => {
    it('returns available/unknown when a dependency throws', () => {
      loadAnthropicCredential.mockImplementation(() => {
        throw new Error('boom');
      });
      const result = modelAvailability('sonnet', slots());
      expect(result).toEqual({ available: true, needs: 'unknown' });
    });

    it('returns available/unknown when resolveOpenAIAuth throws', () => {
      resolveOpenAIAuth.mockImplementation(() => {
        throw new Error('boom');
      });
      const bindings = slots({ medium: { id: 'gpt-5', provider: 'chatgpt-oauth' } });
      const result = modelAvailability('medium', bindings);
      expect(result).toEqual({ available: true, needs: 'unknown' });
    });
  });
});

describe('isModelAvailable', () => {
  beforeEach(() => {
    loadAnthropicCredential.mockReset();
    loadOpenAICredential.mockReset();
    resolveOpenAIAuth.mockReset();
    providerForModel.mockReset();
    providerForModel.mockReturnValue('anthropic-direct');
  });

  it('returns just the boolean verdict', () => {
    loadAnthropicCredential.mockReturnValue('sk-ant-xxx');
    expect(isModelAvailable('sonnet', slots())).toBe(true);
    loadAnthropicCredential.mockReturnValue(undefined);
    expect(isModelAvailable('sonnet', slots())).toBe(false);
  });

  it('is available/unknown for undefined model', () => {
    expect(isModelAvailable(undefined)).toBe(true);
  });
});
