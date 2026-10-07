import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { supportsVision, isOSeriesModel, isReasoningModel } from './model-capabilities.js';
import { resetSlotBindings } from './session/model-slots.js';
import { resetCatalogCache } from './providers/openai-compatible/models-catalog.js';
import { useCodexCatalog } from '../__test-utils__/codex-catalog.js';

// Pin "no Codex catalog" for every case so the static tables are what's under
// test, independent of the developer's real ~/.codex/models_cache.json. The
// catalog-backed cases opt in to a fixture explicitly.
beforeEach(() => useCodexCatalog(null));
afterAll(() => resetCatalogCache());

describe('supportsVision', () => {
  const original = process.env['AFK_VISION_MODELS'];

  beforeEach(() => {
    // Clean slate: no override, default slot bindings (so aliases resolve to
    // the built-in Claude ids regardless of any installed config).
    delete process.env['AFK_VISION_MODELS'];
    resetSlotBindings();
  });

  afterAll(() => {
    if (original === undefined) delete process.env['AFK_VISION_MODELS'];
    else process.env['AFK_VISION_MODELS'] = original;
  });

  it('returns false for empty / undefined', () => {
    expect(supportsVision(undefined)).toBe(false);
    expect(supportsVision('')).toBe(false);
  });

  it('recognises OpenAI vision flagships and the gpt-5.x line', () => {
    for (const m of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4-turbo',
      'gpt-5',
      'gpt-5.5',
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]) {
      expect(supportsVision(m), m).toBe(true);
    }
  });

  it('recognises vision-capable reasoning models but not the text-only minis', () => {
    expect(supportsVision('o1')).toBe(true);
    expect(supportsVision('o3')).toBe(true);
    expect(supportsVision('o4-mini')).toBe(true);
    expect(supportsVision('o1-mini')).toBe(false);
    expect(supportsVision('o3-mini')).toBe(false);
  });

  it('treats Claude models as vision-capable', () => {
    expect(supportsVision('claude-sonnet-5')).toBe(true);
    expect(supportsVision('claude-opus-4-8')).toBe(true);
    expect(supportsVision('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsVision('fable')).toBe(true); // direct alias → claude-fable-5-1
  });

  it('recognises common local vision-language families', () => {
    for (const m of [
      'mlx-community/Qwen2.5-VL-7B-Instruct-4bit',
      'llava-hf/llava-1.5-7b-hf',
      'mistralai/Pixtral-12B-2409',
      'OpenGVLab/InternVL2-8B',
      'meta-llama/Llama-3.2-11B-Vision-Instruct',
      'google/gemma-3-27b-it',
    ]) {
      expect(supportsVision(m), m).toBe(true);
    }
  });

  it('defaults unknown / text-only models to false (graceful degrade)', () => {
    expect(supportsVision('gpt-3.5-turbo')).toBe(false);
    expect(supportsVision('mlx-community/Qwen3-30B-A3B-4bit')).toBe(false);
    expect(supportsVision('deepseek-r1')).toBe(false);
    expect(supportsVision('some-random-proxy-model')).toBe(false);
  });

  it('does not false-positive on "vllm" (a runner, not a model)', () => {
    expect(supportsVision('vllm')).toBe(false);
  });

  it('force-enables an unrecognised id via AFK_VISION_MODELS (substring match)', () => {
    expect(supportsVision('mlx-community/Qwen3-30B-A3B-4bit')).toBe(false);
    process.env['AFK_VISION_MODELS'] = 'qwen3-30b';
    expect(supportsVision('mlx-community/Qwen3-30B-A3B-4bit')).toBe(true);
  });

  it('force-disables via a "!" prefix, which wins over the built-in allowlist', () => {
    process.env['AFK_VISION_MODELS'] = '!gpt-4o-mini';
    expect(supportsVision('gpt-4o-mini')).toBe(false);
    expect(supportsVision('gpt-4o')).toBe(true); // unrelated vision model unaffected
  });
});

describe('isOSeriesModel', () => {
  it('matches the known o-series families (o1/o3/o4) and their variants', () => {
    for (const m of ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini', 'o4-mini-2025-04-16']) {
      expect(isOSeriesModel(m)).toBe(true);
    }
  });

  // Regression: the pre-consolidation copies (providers/index.ts,
  // model-limits.ts) used enumerated startsWith('o1'|'o3'|'o4') and silently
  // misclassified any future oN. This case would have failed against them.
  it('matches future o5+/oN prefixes (the gap the enumerated copies had)', () => {
    for (const m of ['o5', 'o5-mini', 'o6', 'o9-turbo']) {
      expect(isOSeriesModel(m)).toBe(true);
    }
  });

  it('strips a provider/ prefix (OpenRouter-style ids)', () => {
    expect(isOSeriesModel('openai/o3')).toBe(true);
    expect(isOSeriesModel('openrouter/o1-mini')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isOSeriesModel('O3')).toBe(true);
    expect(isOSeriesModel('  o1-mini  ')).toBe(true);
  });

  it('does NOT match non-o-series ids (gpt/claude/codex/local/empty)', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'codex', 'ollama', 'mixtral-8x7b', '', undefined]) {
      expect(isOSeriesModel(m)).toBe(false);
    }
  });
});

describe('isReasoningModel', () => {
  // isReasoningModel is a superset of isOSeriesModel — every o-series id is a
  // reasoning model, but so are the gpt-5.x ids that replace them.

  it('matches all o-series models (delegates to isOSeriesModel)', () => {
    for (const m of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'o5']) {
      expect(isReasoningModel(m), m).toBe(true);
    }
  });

  it('matches gpt-5.x reasoning models (the non-o-series families)', () => {
    for (const m of [
      'gpt-5',
      'gpt-5.1',
      'gpt-5.5',
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5-mini',
      'gpt-5-codex',
    ]) {
      expect(isReasoningModel(m), m).toBe(true);
    }
  });

  it('matches the gpt-6.x line without a catalog', () => {
    for (const m of ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']) {
      expect(isReasoningModel(m), m).toBe(true);
    }
  });

  it('strips provider/ prefix for gpt-5.x ids', () => {
    expect(isReasoningModel('openai/gpt-5')).toBe(true);
    expect(isReasoningModel('openrouter/gpt-5.5')).toBe(true);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isReasoningModel('GPT-5')).toBe(true);
    expect(isReasoningModel('  gpt-5.1  ')).toBe(true);
  });

  it('does NOT match classic chat models (gpt-4o, gpt-4.1, claude, local)', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'claude-sonnet-4', 'codex', 'ollama', 'mixtral-8x7b', '', undefined]) {
      expect(isReasoningModel(m), m).toBe(false);
    }
  });

  it('is a strict superset of isOSeriesModel', () => {
    // Every o-series id must also be a reasoning model.
    const oSeriesIds = ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'openai/o3'];
    for (const m of oSeriesIds) {
      expect(isOSeriesModel(m)).toBe(true);
      expect(isReasoningModel(m)).toBe(true);
    }
    // But gpt-5.x is reasoning without being o-series.
    expect(isOSeriesModel('gpt-5')).toBe(false);
    expect(isReasoningModel('gpt-5')).toBe(true);
  });
});

// Regression: the gpt-6 line, gpt-reserve and codex-auto-review shipped with
// no table entries, so supportsVision() returned false and pasted REPL images
// were replaced by a "cannot view images" notice. The Codex catalog declares
// their modalities; these cases pin that it is consulted.
describe('catalog-backed capabilities', () => {
  const original = process.env['AFK_VISION_MODELS'];
  beforeEach(() => {
    delete process.env['AFK_VISION_MODELS'];
    resetSlotBindings();
    useCodexCatalog([
      { slug: 'gpt-reserve', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'codex-auto-review', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-5-chat-latest', input_modalities: ['text'], supported_reasoning_levels: [] },
      { slug: 'no-fields-model' },
    ]);
  });
  afterAll(() => {
    if (original === undefined) delete process.env['AFK_VISION_MODELS'];
    else process.env['AFK_VISION_MODELS'] = original;
  });

  it('enables vision for catalog models no table pattern knows', () => {
    expect(supportsVision('gpt-reserve')).toBe(true);
    expect(supportsVision('codex-auto-review')).toBe(true);
  });

  it('lets the catalog veto a pattern match when it declares text-only input', () => {
    expect(supportsVision('gpt-5-chat-latest')).toBe(false);
    expect(supportsVision('gpt-5.5')).toBe(true); // unlisted: pattern still applies
  });

  it('keeps AFK_VISION_MODELS overrides above the catalog', () => {
    process.env['AFK_VISION_MODELS'] = '!gpt-reserve,gpt-5-chat-latest';
    expect(supportsVision('gpt-reserve')).toBe(false);
    expect(supportsVision('gpt-5-chat-latest')).toBe(true);
  });

  it('falls through to the tables when the entry has no modalities', () => {
    expect(supportsVision('no-fields-model')).toBe(false);
  });

  it('classifies reasoning models from supported_reasoning_levels', () => {
    expect(isReasoningModel('gpt-reserve')).toBe(true);
    expect(isReasoningModel('codex-auto-review')).toBe(true);
    expect(isReasoningModel('gpt-5-chat-latest')).toBe(false);
    expect(isReasoningModel('o3')).toBe(true); // o-series rule precedes the catalog
  });
});
