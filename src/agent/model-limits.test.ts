/**
 * Tests for model-limits.ts: autoCompactLimitFor (per-model auto-compaction
 * working budget), contextLimitFor (context window), and maxOutputTokensFor
 * (output ceiling).
 *
 * Base `sonnet` has a truthful 1M window (see MODEL_CONTEXT_LIMITS) but is
 * capped at a 200k compaction budget so long default sessions compact early for
 * cost/latency. The `sonnet_1m` opt-in and every non-sonnet model use their
 * full context window. The GPT-5.6-family suites additionally guard the
 * output-cap path — provider-agnostic and shared with openai-compatible — so
 * new gpt-5.x ids do not silently fall through to the 64k default. See
 * src/agent/model-limits.ts.
 */

import { describe, it, expect } from 'vitest';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from './model-limits.js';
import { resolveEffectiveMaxOutputTokens } from './providers/openai-compatible/query/model-params.js';

describe('autoCompactLimitFor', () => {
  it('caps the default sonnet alias at the 200k working budget (not its 1M window)', () => {
    // The window is truthfully 1M; only the compaction trigger is reduced.
    expect(contextLimitFor('sonnet')).toBe(1_000_000);
    expect(autoCompactLimitFor('sonnet')).toBe(200_000);
  });

  it('caps the claude-sonnet-5 wire id at 200k (requestedModel may be the wire id)', () => {
    expect(autoCompactLimitFor('claude-sonnet-5')).toBe(200_000);
  });

  it('the sonnet_1m opt-in bypasses the budget and uses the full 1M window', () => {
    expect(autoCompactLimitFor('sonnet_1m')).toBe(1_000_000);
  });

  it('leaves opus / opus_1m / haiku / fable at their full window (no budget)', () => {
    expect(autoCompactLimitFor('opus')).toBe(200_000);
    expect(autoCompactLimitFor('opus_1m')).toBe(1_000_000);
    expect(autoCompactLimitFor('haiku')).toBe(200_000);
    expect(autoCompactLimitFor('fable')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-fable-5')).toBe(1_000_000);
  });

  it('falls back to the model window for unknown / openai-compatible models', () => {
    expect(autoCompactLimitFor('gpt-4.1')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-xyz' as unknown as 'opus')).toBe(200_000);
    expect(autoCompactLimitFor('mlx-community/qwen3-32b-4bit')).toBe(128_000);
  });

  it('reports the explicit 1M window for the GPT-5.6 family (alias + all variants)', () => {
    // These are explicit MODEL_CONTEXT_LIMITS entries, not the 262k
    // openai-compatible fallback — a regression here means a gpt-5.6 id fell
    // through and would silently allow context overruns.
    for (const id of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
      expect(contextLimitFor(id), id).toBe(1_000_000);
      expect(autoCompactLimitFor(id), id).toBe(1_000_000);
    }
  });
});

describe('maxOutputTokensFor — GPT-5.6 family output ceiling', () => {
  const GPT_56_FAMILY = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

  it('reports the explicit 128k output cap (not the 64k DEFAULT_MAX_OUTPUT fallback)', () => {
    // maxOutputTokensFor is provider-agnostic and drives the openai-compatible
    // output cap too. Without explicit MODEL_MAX_OUTPUT_TOKENS entries these ids
    // fall through to DEFAULT_MAX_OUTPUT (64k) and silently halve the advertised
    // 128k output budget — the exact regression this asserts against.
    for (const id of GPT_56_FAMILY) {
      expect(maxOutputTokensFor(id), id).toBe(128_000);
    }
  });

  it('the openai-compatible request path resolves 128k when config.maxOutputTokens is unset', () => {
    // Mirrors query/model-params.ts:resolveEffectiveMaxOutputTokens, the actual
    // call site for public OpenAI-compatible requests (Chat Completions +
    // Responses). Undefined config → model ceiling, not 64k.
    for (const id of GPT_56_FAMILY) {
      expect(resolveEffectiveMaxOutputTokens(id, undefined), id).toBe(128_000);
    }
  });

  it('still honours an explicit config.maxOutputTokens override', () => {
    expect(resolveEffectiveMaxOutputTokens('gpt-5.6', 8_000)).toBe(8_000);
  });
});
