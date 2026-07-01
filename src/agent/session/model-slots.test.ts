/**
 * Tests for user-configurable model slots (Stage 1).
 * @module agent/session/model-slots.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_FABLE_5_ID,
  computeSlotBindings,
  DEFAULT_SLOT_BINDINGS,
  DIRECT_MODEL_ALIASES,
  getSlotBindings,
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

  it('resolves legacy Claude aliases to tiers', () => {
    expect(slotForInput('haiku')).toBe('small');
    expect(slotForInput('sonnet')).toBe('medium');
    expect(slotForInput('sonnet_1m')).toBe('medium');
    expect(slotForInput('opus')).toBe('large');
    expect(slotForInput('opus_1m')).toBe('large');
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
  it('resolves slot aliases to the default bound id', () => {
    expect(resolveModelInput('small')).toBe(DEFAULT_SLOT_BINDINGS.small.id);
    expect(resolveModelInput('sonnet')).toBe(DEFAULT_SLOT_BINDINGS.medium.id);
    expect(resolveModelInput('opus')).toBe(DEFAULT_SLOT_BINDINGS.large.id);
  });

  it('resolves to a rebound id', () => {
    const bindings = makeSlots({ small: 'gpt-4o-mini' });
    expect(resolveModelInput('small', bindings)).toBe('gpt-4o-mini');
    expect(resolveModelInput('haiku', bindings)).toBe('gpt-4o-mini');
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
