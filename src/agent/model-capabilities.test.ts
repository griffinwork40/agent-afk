import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { supportsVision } from './model-capabilities.js';
import { resetSlotBindings } from './session/model-slots.js';

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
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo', 'gpt-5', 'gpt-5.5']) {
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
    expect(supportsVision('claude-sonnet-4-6')).toBe(true);
    expect(supportsVision('claude-opus-4-8')).toBe(true);
    expect(supportsVision('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsVision('fable')).toBe(true); // direct alias → claude-fable-5
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
