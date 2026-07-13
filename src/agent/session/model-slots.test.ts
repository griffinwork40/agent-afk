/**
 * Tests for user-configurable model slots (Stage 1).
 * @module agent/session/model-slots.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_FABLE_5_ID,
  CLAUDE_HAIKU_ID,
  CLAUDE_OPUS_ID,
  CLAUDE_SONNET_ID,
  coerceSlotBindingInput,
  computeSlotBindings,
  DEFAULT_SLOT_BINDINGS,
  DIRECT_MODEL_ALIASES,
  getSlotBindings,
  MODEL_ALIASES_HINT,
  parseModelsConfig,
  resetSlotBindings,
  resolveBinding,
  resolveModelInput,
  setSlotBindings,
  slotForInput,
  SLOT_NAMES,
  unconfiguredSlotError,
  type ModelSlots,
} from './model-slots.js';
import { contextLimitFor, maxOutputTokensFor } from '../model-limits.js';

const ENV_KEYS = [
  'AFK_MODEL_LOCAL',
  'AFK_MODEL_LOCAL_BASE_URL',
  'AFK_MODEL_LOCAL_API_KEY',
  'AFK_MODEL_SMALL',
  'AFK_MODEL_MEDIUM',
  'AFK_MODEL_LARGE',
  'AFK_MODEL_SMALL_BASE_URL',
  'AFK_MODEL_SMALL_API_KEY',
  'AFK_MODEL_MEDIUM_BASE_URL',
  'AFK_MODEL_MEDIUM_API_KEY',
  'AFK_MODEL_LARGE_BASE_URL',
  'AFK_MODEL_LARGE_API_KEY',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function makeSlots(over: Partial<Record<'local' | 'small' | 'medium' | 'large', string>>): ModelSlots {
  return {
    local: { id: over.local ?? DEFAULT_SLOT_BINDINGS.local.id },
    small: { id: over.small ?? DEFAULT_SLOT_BINDINGS.small.id },
    medium: { id: over.medium ?? DEFAULT_SLOT_BINDINGS.medium.id },
    large: { id: over.large ?? DEFAULT_SLOT_BINDINGS.large.id },
  };
}

afterEach(() => {
  resetSlotBindings();
  clearEnv();
});

describe('SLOT_NAMES', () => {
  it('has four entries with local first', () => {
    expect(SLOT_NAMES).toHaveLength(4);
    expect(SLOT_NAMES[0]).toBe('local');
    expect(SLOT_NAMES).toEqual(['local', 'small', 'medium', 'large']);
  });
});

describe('slotForInput', () => {
  it('resolves neutral tier names', () => {
    expect(slotForInput('local')).toBe('local');
    expect(slotForInput('LOCAL')).toBe('local');
    expect(slotForInput('Local')).toBe('local');
    expect(slotForInput('small')).toBe('small');
    expect(slotForInput('MEDIUM')).toBe('medium');
    expect(slotForInput(' large ')).toBe('large');
  });

  it('does NOT map the Claude identity aliases to tiers (they are fixed-id, not slots)', () => {
    // The #548 decoupling: sonnet/opus/haiku/*_1m are fixed-identity aliases
    // (DIRECT_MODEL_ALIASES), never tier pointers — so slotForInput must miss them.
    expect(slotForInput('haiku')).toBeUndefined();
    expect(slotForInput('sonnet')).toBeUndefined();
    expect(slotForInput('sonnet_1m')).toBeUndefined();
    expect(slotForInput('opus')).toBeUndefined();
    expect(slotForInput('opus_1m')).toBeUndefined();
  });

  it('resolves user custom names (case-insensitive) and prefers them', () => {
    const bindings = makeSlots({ small: 'gpt-4o-mini' });
    bindings.small.name = 'Fast';
    expect(slotForInput('fast', bindings)).toBe('small');
    expect(slotForInput('FAST', bindings)).toBe('small');
  });

  it('returns undefined for auto sentinel and raw ids', () => {
    expect(slotForInput('auto')).toBeUndefined();
    expect(slotForInput('claude-sonnet-5')).toBeUndefined();
    expect(slotForInput('gpt-4o-mini')).toBeUndefined();
    expect(slotForInput('')).toBeUndefined();
  });
});

describe('resolveModelInput', () => {
  it('resolves neutral tier names to the default bound id', () => {
    expect(resolveModelInput('small')).toBe(DEFAULT_SLOT_BINDINGS.small.id);
    expect(resolveModelInput('medium')).toBe(DEFAULT_SLOT_BINDINGS.medium.id);
    expect(resolveModelInput('large')).toBe(DEFAULT_SLOT_BINDINGS.large.id);
  });

  it('resolves a rebound TIER to its new id, but leaves identity aliases pinned', () => {
    const bindings = makeSlots({ small: 'gpt-4o-mini' });
    expect(resolveModelInput('small', bindings)).toBe('gpt-4o-mini');
    // `haiku` is a fixed identity alias — a rebound `small` tier must NOT drag it.
    expect(resolveModelInput('haiku', bindings)).toBe(CLAUDE_HAIKU_ID);
  });

  it('passes through raw ids, the auto sentinel, and undefined', () => {
    expect(resolveModelInput('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelInput('mlx-community/Qwen3-32B-4bit')).toBe('mlx-community/Qwen3-32B-4bit');
    expect(resolveModelInput('auto')).toBe('auto');
    expect(resolveModelInput(undefined)).toBeUndefined();
  });
});

describe('Claude Fable 5 fixed-id alias', () => {
  it('exposes the canonical wire id via the direct-alias table', () => {
    expect(CLAUDE_FABLE_5_ID).toBe('claude-fable-5');
    expect(DIRECT_MODEL_ALIASES['fable']).toBe('claude-fable-5');
  });

  it('resolves the `fable` alias straight to claude-fable-5 (case-insensitive)', () => {
    expect(resolveModelInput('fable')).toBe('claude-fable-5');
    expect(resolveModelInput('FABLE')).toBe('claude-fable-5');
    expect(resolveModelInput('  Fable  ')).toBe('claude-fable-5');
    expect(resolveBinding('fable')).toEqual({ id: 'claude-fable-5' });
  });

  it('is NOT a capability tier — slotForInput never matches it', () => {
    // fable sits above the large/opus slot, so it has no tier of its own.
    expect(slotForInput('fable')).toBeUndefined();
  });

  it('stays pinned to claude-fable-5 regardless of slot rebindings', () => {
    // The direct alias bypasses slot bindings entirely: rebinding every tier to
    // an OpenAI id must not drag `fable` off claude-fable-5.
    const rebound = makeSlots({ small: 'gpt-4o-mini', medium: 'gpt-4o', large: 'gpt-4o' });
    expect(resolveModelInput('fable', rebound)).toBe('claude-fable-5');
  });

  it('reports the 1M context window and 128k max output', () => {
    expect(contextLimitFor('fable')).toBe(1_000_000);
    expect(contextLimitFor('claude-fable-5')).toBe(1_000_000);
    expect(maxOutputTokensFor('fable')).toBe(128_000);
    expect(maxOutputTokensFor('claude-fable-5')).toBe(128_000);
  });
});

describe('fixed-identity Claude aliases (sonnet/opus/haiku decoupled from tiers, #548)', () => {
  it('exposes each identity alias via the direct-alias table', () => {
    expect(DIRECT_MODEL_ALIASES['sonnet']).toBe(CLAUDE_SONNET_ID);
    expect(DIRECT_MODEL_ALIASES['opus']).toBe(CLAUDE_OPUS_ID);
    expect(DIRECT_MODEL_ALIASES['haiku']).toBe(CLAUDE_HAIKU_ID);
    expect(DIRECT_MODEL_ALIASES['sonnet_1m']).toBe(CLAUDE_SONNET_ID);
    expect(DIRECT_MODEL_ALIASES['opus_1m']).toBe(CLAUDE_OPUS_ID);
  });

  it('resolves each identity alias to its pinned wire id (case-insensitive)', () => {
    expect(resolveModelInput('sonnet')).toBe(CLAUDE_SONNET_ID);
    expect(resolveModelInput('OPUS')).toBe(CLAUDE_OPUS_ID);
    expect(resolveBinding('haiku')).toEqual({ id: CLAUDE_HAIKU_ID });
  });

  it('stays pinned regardless of tier rebindings — the collision fix', () => {
    // Rebinding medium/small/large to OpenAI ids must NOT hijack the sonnet/
    // haiku/opus handles (the pre-#548 footgun where `sonnet` == the medium tier).
    const rebound = makeSlots({ small: 'gpt-4o-mini', medium: 'gpt-5.6', large: 'gpt-5.6' });
    expect(resolveModelInput('sonnet', rebound)).toBe(CLAUDE_SONNET_ID);
    expect(resolveModelInput('opus', rebound)).toBe(CLAUDE_OPUS_ID);
    expect(resolveModelInput('haiku', rebound)).toBe(CLAUDE_HAIKU_ID);
  });

  it('preserves the *_1m 1M context-window opt-in after decoupling', () => {
    expect(contextLimitFor('sonnet_1m')).toBe(1_000_000);
    expect(contextLimitFor('opus_1m')).toBe(1_000_000);
  });
});

describe('MODEL_ALIASES_HINT (single source of truth for the /model picker)', () => {
  it('is derived from the tiers + identity aliases, in the documented order', () => {
    expect(MODEL_ALIASES_HINT).toEqual([
      'local', 'small', 'medium', 'large',
      'opus', 'opus_1m', 'sonnet', 'sonnet_1m', 'haiku', 'fable',
    ]);
  });
});

describe('local slot', () => {
  it('DEFAULT_SLOT_BINDINGS has local with empty id', () => {
    expect(DEFAULT_SLOT_BINDINGS.local).toEqual({ id: '' });
  });

  it('computeSlotBindings includes local key equal to DEFAULT_SLOT_BINDINGS.local when no env set', () => {
    const out = computeSlotBindings();
    expect(out.local).toEqual(DEFAULT_SLOT_BINDINGS.local);
    expect(Object.keys(out)).toContain('local');
  });

  it('AFK_MODEL_LOCAL overrides local slot id', () => {
    process.env['AFK_MODEL_LOCAL'] = 'test-model';
    expect(computeSlotBindings().local.id).toBe('test-model');
  });

  it('AFK_MODEL_LOCAL_BASE_URL wires through to local.baseUrl', () => {
    process.env['AFK_MODEL_LOCAL_BASE_URL'] = 'http://localhost:1234';
    expect(computeSlotBindings().local.baseUrl).toBe('http://localhost:1234');
  });

  it('AFK_MODEL_LOCAL_API_KEY wires through to local.apiKey', () => {
    process.env['AFK_MODEL_LOCAL_API_KEY'] = 'sk-local';
    expect(computeSlotBindings().local.apiKey).toBe('sk-local');
  });

  it('parseModelsConfig supports local key', () => {
    const out = parseModelsConfig({ local: 'lm-studio-model' });
    expect(out.local).toEqual({ id: 'lm-studio-model' });
  });

  it('resolveModelInput("local") returns empty string when unconfigured', () => {
    // local default id is '' — not undefined or a crash
    expect(resolveModelInput('local')).toBe('');
  });

  it('slotForInput does NOT match a raw id that merely contains "local"', () => {
    // Exact-token match only — an Ollama/HF id like these must pass through as a
    // raw id, never collide with the `local` slot alias.
    expect(slotForInput('local-llama-3')).toBeUndefined();
    expect(slotForInput('mlx-community/local-model')).toBeUndefined();
    expect(resolveModelInput('local-llama-3')).toBe('local-llama-3');
  });

  it('unconfiguredSlotError flags an unconfigured local tier with an actionable message', () => {
    const msg = unconfiguredSlotError('local');
    expect(msg).toBeTruthy();
    expect(msg).toContain('AFK_MODEL_LOCAL');
    expect(msg).toContain('models.local');
  });

  it('unconfiguredSlotError matches the slot alias case-insensitively', () => {
    expect(unconfiguredSlotError('LOCAL')).toBeTruthy();
  });

  it('unconfiguredSlotError returns undefined once local is configured', () => {
    process.env['AFK_MODEL_LOCAL'] = 'llama3.2:3b';
    expect(unconfiguredSlotError('local')).toBeUndefined();
  });

  it('unconfiguredSlotError returns undefined for configured tiers, raw ids, aliases, and undefined', () => {
    expect(unconfiguredSlotError('small')).toBeUndefined();
    expect(unconfiguredSlotError('sonnet')).toBeUndefined();
    expect(unconfiguredSlotError('gpt-4o-mini')).toBeUndefined();
    expect(unconfiguredSlotError('auto')).toBeUndefined();
    expect(unconfiguredSlotError(undefined)).toBeUndefined();
  });
});

describe('computeSlotBindings', () => {
  it('returns defaults with no overrides', () => {
    expect(computeSlotBindings()).toEqual(DEFAULT_SLOT_BINDINGS);
  });

  it('applies file overrides over defaults', () => {
    const out = computeSlotBindings({ small: { id: 'gpt-4o-mini', name: 'fast' } });
    expect(out.small).toEqual({ id: 'gpt-4o-mini', name: 'fast' });
    expect(out.medium).toEqual(DEFAULT_SLOT_BINDINGS.medium);
  });

  it('lets env override the file id while preserving the file name', () => {
    process.env['AFK_MODEL_SMALL'] = 'o4-mini';
    const out = computeSlotBindings({ small: { id: 'gpt-4o-mini', name: 'fast' } });
    expect(out.small).toEqual({ id: 'o4-mini', name: 'fast' });
  });

  it('ignores blank env values', () => {
    process.env['AFK_MODEL_LARGE'] = '   ';
    expect(computeSlotBindings().large).toEqual(DEFAULT_SLOT_BINDINGS.large);
  });
});

describe('getSlotBindings / setSlotBindings', () => {
  it('prefers an explicit override, then the installed table, then computed defaults', () => {
    expect(getSlotBindings()).toEqual(DEFAULT_SLOT_BINDINGS);
    const installed = makeSlots({ medium: 'gpt-4.1' });
    setSlotBindings(installed);
    expect(getSlotBindings()).toEqual(installed);
    const override = makeSlots({ large: 'o3' });
    expect(getSlotBindings(override)).toEqual(override);
    resetSlotBindings();
    expect(getSlotBindings()).toEqual(DEFAULT_SLOT_BINDINGS);
  });
});

describe('parseModelsConfig', () => {
  it('parses bare-string and object forms', () => {
    const out = parseModelsConfig({
      small: 'gpt-4o-mini',
      medium: { id: 'claude-sonnet-5', name: 'balanced' },
    });
    expect(out.small).toEqual({ id: 'gpt-4o-mini' });
    expect(out.medium).toEqual({ id: 'claude-sonnet-5', name: 'balanced' });
    expect(out.large).toBeUndefined();
  });

  it('skips malformed entries and non-objects', () => {
    expect(parseModelsConfig(null)).toEqual({});
    expect(parseModelsConfig('nope')).toEqual({});
    expect(parseModelsConfig({ small: 42, medium: { name: 'no-id' }, large: '' })).toEqual({});
  });
});

describe('model-limits resolves through slot bindings', () => {
  it('uses default tier limits when unconfigured', () => {
    expect(contextLimitFor('small')).toBe(200_000);
    expect(maxOutputTokensFor('small')).toBe(64_000);
  });

  it('preserves the explicit *_1m context-window choice', () => {
    expect(contextLimitFor('sonnet_1m')).toBe(1_000_000);
    expect(contextLimitFor('opus_1m')).toBe(1_000_000);
  });

  it('reflects a rebound tier limit', () => {
    setSlotBindings(makeSlots({ small: 'gpt-4o-mini' }));
    expect(contextLimitFor('small')).toBe(128_000);
    setSlotBindings(makeSlots({ small: 'claude-opus-4-8' }));
    expect(maxOutputTokensFor('small')).toBe(128_000);
  });
});

describe('Stage 2: per-slot provider credentials', () => {
  it('parseBinding parses + normalizes provider, baseUrl, apiKey', () => {
    expect(
      parseModelsConfig({
        small: { id: 'x', provider: 'OpenAI-Compatible', baseUrl: ' http://h/v1 ', apiKey: ' k ' },
      }).small,
    ).toEqual({ id: 'x', provider: 'openai', baseUrl: 'http://h/v1', apiKey: 'k' });
    expect(parseModelsConfig({ large: { id: 'y', provider: 'anthropic' } }).large).toEqual({
      id: 'y',
      provider: 'anthropic',
    });
    // Unknown provider value is dropped (not a SlotProvider).
    expect(parseModelsConfig({ medium: { id: 'z', provider: 'gemini' } }).medium).toEqual({ id: 'z' });
  });

  it('parseBinding normalizes the chatgpt-oauth provider (+ chatgpt shorthand)', () => {
    expect(parseModelsConfig({ medium: { id: 'gpt-5.6', provider: 'chatgpt-oauth' } }).medium).toEqual({
      id: 'gpt-5.6',
      provider: 'chatgpt-oauth',
    });
    expect(parseModelsConfig({ small: { id: 'gpt-5.6', provider: 'ChatGPT' } }).small).toEqual({
      id: 'gpt-5.6',
      provider: 'chatgpt-oauth',
    });
  });

  it('resolveBinding returns per-slot creds for a slot alias, bare {id} for a raw id', () => {
    const bindings = computeSlotBindings({
      small: { id: 'gpt-4o-mini', provider: 'openai', baseUrl: 'http://h/v1', apiKey: 'k' },
    });
    expect(resolveBinding('small', bindings)).toEqual({
      id: 'gpt-4o-mini',
      provider: 'openai',
      baseUrl: 'http://h/v1',
      apiKey: 'k',
    });
    expect(resolveBinding('claude-sonnet-5', bindings)).toEqual({ id: 'claude-sonnet-5' });
  });

  it('computeSlotBindings keeps file creds and lets env override baseUrl/apiKey', () => {
    process.env['AFK_MODEL_SMALL_BASE_URL'] = 'http://env/v1';
    process.env['AFK_MODEL_SMALL_API_KEY'] = 'env-key';
    const out = computeSlotBindings({
      small: { id: 'gpt-4o-mini', name: 'fast', provider: 'openai', baseUrl: 'http://file/v1', apiKey: 'file-key' },
    });
    expect(out.small).toEqual({
      id: 'gpt-4o-mini',
      name: 'fast',
      provider: 'openai',
      baseUrl: 'http://env/v1',
      apiKey: 'env-key',
    });
  });
});

describe('coerceSlotBindingInput', () => {
  it('accepts a minimal object with just an id', () => {
    expect(coerceSlotBindingInput({ id: 'glm-5.2' })).toEqual({ ok: true, value: { id: 'glm-5.2' } });
  });
  it('accepts an object with id + provider and normalizes provider aliases', () => {
    expect(coerceSlotBindingInput({ id: 'glm-5.2', provider: 'openai-compatible' })).toEqual(
      { ok: true, value: { id: 'glm-5.2', provider: 'openai' } },
    );
  });
  it('accepts an object with id + provider + name', () => {
    expect(coerceSlotBindingInput({ id: 'glm-5.2', provider: 'openai', name: 'fast' })).toEqual(
      { ok: true, value: { id: 'glm-5.2', provider: 'openai', name: 'fast' } },
    );
  });
  it('rejects a non-object', () => {
    expect(coerceSlotBindingInput('glm-5.2').ok).toBe(false);
    expect(coerceSlotBindingInput(null).ok).toBe(false);
    expect(coerceSlotBindingInput(['glm-5.2']).ok).toBe(false);
  });
  it('rejects a missing id', () => {
    expect(coerceSlotBindingInput({}).ok).toBe(false);
    expect(coerceSlotBindingInput({ provider: 'openai' }).ok).toBe(false);
  });
  it('rejects an unrecognized provider', () => {
    const res = coerceSlotBindingInput({ id: 'glm-5.2', provider: 'opencode-go' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/provider/);
  });
  it('rejects a per-slot apiKey (camelCase and snake_case)', () => {
    expect(coerceSlotBindingInput({ id: 'glm-5.2', apiKey: 'sk-secret' }).ok).toBe(false);
    expect(coerceSlotBindingInput({ id: 'glm-5.2', api_key: 'sk-secret' }).ok).toBe(false);
  });
  it('rejects a per-slot baseUrl (camelCase and snake_case) as an endpoint-redirect credential vector', () => {
    const res = coerceSlotBindingInput({ id: 'glm-5.2', baseUrl: 'https://attacker.example/v1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/AFK_MODEL_.*BASE_URL/);
    const resSnake = coerceSlotBindingInput({ id: 'glm-5.2', base_url: 'https://attacker.example/v1' });
    expect(resSnake.ok).toBe(false);
    if (!resSnake.ok) expect(resSnake.error).toMatch(/AFK_MODEL_.*BASE_URL/);
  });
  it('rejects control characters in id and name', () => {
    const resId = coerceSlotBindingInput({ id: 'glm\r\n-5.2' });
    expect(resId.ok).toBe(false);
    if (!resId.ok) expect(resId.error).toMatch(/control characters/);
    const resName = coerceSlotBindingInput({ id: 'glm-5.2', name: 'evil\ntier' });
    expect(resName.ok).toBe(false);
    if (!resName.ok) expect(resName.error).toMatch(/control characters/);
  });
  it('rejects names that shadow built-in aliases (slot keys, legacy aliases, auto, direct aliases)', () => {
    for (const reserved of ['local', 'small', 'medium', 'large', 'haiku', 'sonnet', 'opus', 'auto', 'fable']) {
      const res = coerceSlotBindingInput({ id: 'glm-5.2', name: reserved });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/shadow a built-in alias/);
    }
  });
});
