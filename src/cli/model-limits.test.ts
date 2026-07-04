/**
 * Tests for src/cli/model-limits.ts
 */

import { describe, it, expect } from 'vitest';
import { MODEL_CONTEXT_LIMITS, contextLimitFor } from './model-limits.js';

describe('model-limits', () => {
  it('declares limits for opus, opus_1m, sonnet, sonnet_1m, haiku', () => {
    expect(MODEL_CONTEXT_LIMITS['opus']).toBe(200_000);
    expect(MODEL_CONTEXT_LIMITS['opus_1m']).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS['sonnet']).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS['sonnet_1m']).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS['haiku']).toBe(200_000);
  });

  it('contextLimitFor returns the declared limit for known models', () => {
    expect(contextLimitFor('opus')).toBe(200_000);
    expect(contextLimitFor('sonnet_1m')).toBe(1_000_000);
  });

  it('declares the 1M context window for Claude Fable 5 (alias + wire id)', () => {
    // Fable 5 ships 1M natively (no `_1m` opt-in). Both the `fable` alias and
    // the `claude-fable-5` wire id must report the full window, not the 200k
    // Anthropic fallback.
    expect(MODEL_CONTEXT_LIMITS['fable']).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS['claude-fable-5']).toBe(1_000_000);
    expect(contextLimitFor('fable')).toBe(1_000_000);
    expect(contextLimitFor('claude-fable-5')).toBe(1_000_000);
  });

  it('declares the 1M context window for Claude Sonnet 5 (alias + wire id)', () => {
    // Sonnet 5 ships 1M natively — no `_1m` opt-in needed for the window. Both
    // the `sonnet` alias and the `claude-sonnet-5` wire id report the full 1M
    // window. `sonnet_1m` also reports 1M and additionally opts out of the
    // default auto-compaction budget (see autoCompactLimitFor).
    expect(MODEL_CONTEXT_LIMITS['sonnet']).toBe(1_000_000);
    expect(MODEL_CONTEXT_LIMITS['claude-sonnet-5']).toBe(1_000_000);
    expect(contextLimitFor('sonnet')).toBe(1_000_000);
    expect(contextLimitFor('claude-sonnet-5')).toBe(1_000_000);
    expect(contextLimitFor('sonnet_1m')).toBe(1_000_000);
  });

  it('contextLimitFor falls back to 200k for unknown Anthropic-style models', () => {
    expect(contextLimitFor('claude-xyz' as unknown as 'opus')).toBe(200_000);
    expect(contextLimitFor('')).toBe(200_000);
  });

  it('contextLimitFor falls back to 256k for HF-style ids (openai-compatible)', () => {
    // Local MLX server hosting Qwen3.6 — what motivated the per-provider fallback.
    expect(contextLimitFor('mlx-community/Qwen3.6-35B-A3B-4bit')).toBe(262_144);
    // Generic HF org/model id served via vLLM/llama.cpp openai-shim.
    expect(contextLimitFor('Qwen/Qwen3-32B')).toBe(262_144);
    expect(contextLimitFor('mlx-community/Llama-3.3-70B-Instruct-4bit')).toBe(262_144);
  });

  it('contextLimitFor falls back to 256k for unknown OpenAI-branded models', () => {
    // Future gpt/o3-o4/codex variants not yet listed in MODEL_CONTEXT_LIMITS
    // get the openai-compatible fallback rather than the 200k Anthropic one.
    // Predicate must mirror providers/index.ts:providerForModel — only o1/o3/o4
    // o-series prefixes route to openai-compatible today (o5+ would need router
    // update first; see routesToOpenAICompatible in agent/model-limits.ts).
    expect(contextLimitFor('gpt-5-preview')).toBe(262_144);
    expect(contextLimitFor('o3-pro')).toBe(262_144);
    expect(contextLimitFor('o4-preview')).toBe(262_144);
    expect(contextLimitFor('codex-next')).toBe(262_144);
  });

  it('contextLimitFor still returns the listed limit for known OpenAI models', () => {
    // The fallback only fires when MODEL_CONTEXT_LIMITS has no entry —
    // confirm explicit entries still win.
    expect(contextLimitFor('gpt-4o')).toBe(128_000);
    expect(contextLimitFor('o1-mini')).toBe(128_000);
    expect(contextLimitFor('gpt-4.1')).toBe(1_000_000);
  });

  it('contextLimitFor returns declared limit for mlx-community entries (exact lowercase)', () => {
    // These models have explicit entries that override the 262k openai-compatible
    // fallback — critical because their actual context windows are smaller.
    expect(contextLimitFor('mlx-community/qwen3-30b-a3b-4bit')).toBe(128_000);
    expect(contextLimitFor('mlx-community/qwen3-32b-4bit')).toBe(128_000);
    expect(contextLimitFor('mlx-community/qwen2.5-coder-32b-instruct-4bit')).toBe(131_072);
  });

  it('contextLimitFor normalises mlx-community casing for mixed-case AFK_MODEL values', () => {
    // Users typically copy the HuggingFace model ID as-is (PascalCase).
    // contextLimitFor() must lowercase before lookup so these hit the declared
    // entry rather than the 262k openai-compatible fallback.
    expect(contextLimitFor('mlx-community/Qwen3-30B-A3B-4bit')).toBe(128_000);
    expect(contextLimitFor('mlx-community/Qwen3-32B-4bit')).toBe(128_000);
    expect(contextLimitFor('mlx-community/Qwen2.5-Coder-32B-Instruct-4bit')).toBe(131_072);
  });
});
