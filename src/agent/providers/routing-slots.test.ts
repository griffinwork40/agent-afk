/**
 * Provider routing through user-configurable model slots (Stage 1).
 *
 * Proves the resolution-before-routing fix: a capability tier rebound to a
 * non-Anthropic model routes to the correct provider — including through the
 * child-dispatch path (`createChildProviderFactory`), which previously routed
 * on the raw alias and would have misrouted a rebound tier to anthropic-direct.
 *
 * @module agent/providers/routing-slots.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerForModel, resolveProvider } from './index.js';
import { createChildProviderFactory } from '../tools/nesting.js';
import { AnthropicDirectProvider } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';
import {
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
  type ModelSlots,
} from '../session/model-slots.js';
import type { SubagentExecutor } from '../tools/subagent-executor.js';
import type { SkillExecutor } from '../tools/skill-executor.js';

const ENV_KEYS = ['AFK_PROVIDER', 'AFK_OPENAI_BASE_URL', 'AFK_MODEL_SMALL', 'AFK_MODEL_MEDIUM', 'AFK_MODEL_LARGE'] as const;
const saved: Record<string, string | undefined> = {};

function makeSlots(over: Partial<ModelSlots>): ModelSlots {
  return {
    local: over.local ?? { id: DEFAULT_SLOT_BINDINGS.local.id },
    small: over.small ?? { id: DEFAULT_SLOT_BINDINGS.small.id },
    medium: over.medium ?? { id: DEFAULT_SLOT_BINDINGS.medium.id },
    large: over.large ?? { id: DEFAULT_SLOT_BINDINGS.large.id },
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  resetSlotBindings();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('providerForModel — slot resolution', () => {
  it('routes default tier names to anthropic-direct', () => {
    expect(providerForModel('small')).toBe('anthropic-direct');
    expect(providerForModel('medium')).toBe('anthropic-direct');
    expect(providerForModel('large')).toBe('anthropic-direct');
  });

  it('routes a tier rebound to an OpenAI id via hints.slots', () => {
    const slots = makeSlots({ small: { id: 'gpt-4o-mini' } });
    expect(providerForModel('small', { slots })).toBe('openai-compatible');
    // `haiku` is a fixed identity alias (#548) — a rebound `small` tier must NOT
    // drag it off Claude.
    expect(providerForModel('haiku', { slots })).toBe('anthropic-direct');
  });

  it('routes a tier rebound to a local HF-style id', () => {
    const slots = makeSlots({ medium: { id: 'mlx-community/Qwen3-32B-4bit' } });
    expect(providerForModel('medium', { slots })).toBe('openai-compatible');
    // `sonnet` is a fixed identity alias (#548) — a rebound `medium` tier must NOT
    // hijack it (the pre-#548 collision).
    expect(providerForModel('sonnet', { slots })).toBe('anthropic-direct');
  });

  it('routes by the bound id when matching a user custom name', () => {
    const slots = makeSlots({ small: { id: 'gpt-4o-mini', name: 'fast' } });
    expect(providerForModel('fast', { slots })).toBe('openai-compatible');
  });

  it('honors the process-global installed bindings', () => {
    setSlotBindings(makeSlots({ large: { id: 'o3' } }));
    expect(providerForModel('large')).toBe('openai-compatible');
    // `opus` is a fixed identity alias (#548) — a rebound `large` tier must NOT
    // drag it off Claude.
    expect(providerForModel('opus')).toBe('anthropic-direct');
  });

  it('keeps the auto sentinel on anthropic-direct even with rebindings', () => {
    setSlotBindings(makeSlots({ small: { id: 'gpt-4o-mini' } }));
    expect(providerForModel('auto')).toBe('anthropic-direct');
  });

  it('still lets an explicit provider override win over a rebound tier', () => {
    const slots = makeSlots({ small: { id: 'gpt-4o-mini' } });
    expect(providerForModel('small', { slots, explicit: 'anthropic' })).toBe('anthropic-direct');
  });
});

describe('providerForModel — explicit per-slot provider override (Stage 2)', () => {
  it('routes a bare id to openai-compatible when the slot declares provider=openai', () => {
    const slots = makeSlots({ medium: { id: 'my-local-llama', provider: 'openai' } });
    expect(providerForModel('medium', { slots })).toBe('openai-compatible');
  });

  it('routes a non-Claude id to anthropic-direct when the slot declares provider=anthropic', () => {
    const slots = makeSlots({ small: { id: 'custom-shim-model', provider: 'anthropic' } });
    expect(providerForModel('small', { slots })).toBe('anthropic-direct');
  });

  it('lets the global explicit provider beat the per-slot provider', () => {
    const slots = makeSlots({ small: { id: 'my-local-llama', provider: 'openai' } });
    expect(providerForModel('small', { slots, explicit: 'anthropic' })).toBe('anthropic-direct');
  });
});

describe('providerForModel — per-slot baseUrl routing (Tier 3.5)', () => {
  it('routes a bare id with a per-slot baseUrl to openai-compatible', () => {
    // The documented env-only local shim: AFK_MODEL_LOCAL=llama3.2:3b +
    // AFK_MODEL_LOCAL_BASE_URL. The id matches no provider prefix, so the
    // per-slot baseUrl is the routing signal that reaches the shim.
    const slots = makeSlots({ local: { id: 'llama3.2:3b', baseUrl: 'http://localhost:11434/v1' } });
    expect(providerForModel('local', { slots })).toBe('openai-compatible');
  });

  it('routes a configured tier with a baseUrl + bare id to openai-compatible', () => {
    const slots = makeSlots({ small: { id: 'my-shim-model', baseUrl: 'http://localhost:8080/v1' } });
    expect(providerForModel('small', { slots })).toBe('openai-compatible');
  });

  it('keeps a local-* id on anthropic-direct even with a per-slot baseUrl (Anthropic-shim path)', () => {
    const slots = makeSlots({ local: { id: 'local-claude-shim', baseUrl: 'http://localhost:9000' } });
    expect(providerForModel('local', { slots })).toBe('anthropic-direct');
  });

  it('keeps a claude-* id on anthropic-direct even with a per-slot baseUrl', () => {
    const slots = makeSlots({ medium: { id: 'claude-sonnet-5', baseUrl: 'http://proxy.internal' } });
    expect(providerForModel('medium', { slots })).toBe('anthropic-direct');
  });
});

describe('resolveProvider — slot resolution', () => {
  it('constructs the right provider instance for a rebound tier', () => {
    const slots = makeSlots({ small: { id: 'gpt-4o-mini' } });
    expect(resolveProvider('small', { slots })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(resolveProvider('medium', { slots })).toBeInstanceOf(AnthropicDirectProvider);
  });
});

describe('createChildProviderFactory — rebound tier reaches the right provider', () => {
  // Minimal stubs — the factory only consults the resolved `model`.
  const childExecutor = {} as SubagentExecutor;
  const childSkillExecutor = {} as SkillExecutor;

  it('routes a default tier child to AnthropicDirectProvider', () => {
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model: 'small' });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it('routes a rebound tier child to OpenAICompatibleProvider (the child-dispatch fix)', () => {
    setSlotBindings(makeSlots({ small: { id: 'gpt-4o-mini' } }));
    const factory = createChildProviderFactory();
    // The executors pass the raw tier alias ('small'); the fix resolves it to
    // the bound id inside providerForModel before routing.
    const provider = factory({ childExecutor, childSkillExecutor, model: 'small' });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
