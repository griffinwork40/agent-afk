/**
 * Unit tests for the openai-compatible pricing table.
 *
 * The load-bearing assertion in this file is the unknown-vs-zero
 * distinction (issue #865, sibling issue #866): a model absent from
 * {@link MODEL_PRICING} must derive `undefined` cost, never `0`, so a
 * downstream `?? 0` coalescing bug cannot silently misreport "we don't know"
 * as "this was free."
 *
 * @module agent/providers/openai-compatible/pricing.test
 */

import { describe, it, expect } from 'vitest';
import { deriveCallCostUsd, MODEL_PRICING } from './pricing.js';

const M = 1_000_000;

describe('deriveCallCostUsd — known models price correctly', () => {
  it('prices a plain gpt-4o call from base rates', () => {
    // $2.50 input + $10.00 output per MTok.
    const cost = deriveCallCostUsd('gpt-4o', M, M, 0);
    expect(cost).toBeCloseTo(12.5, 8);
  });

  it('applies the discounted cached-input rate for the cached portion only', () => {
    // gpt-4o: $2.50 plain input, $1.25 cached input per MTok. Half the input
    // is cached: 0.5 * 1.25 + 0.5 * 2.50 = 1.875 for input, plus 0 output.
    const cost = deriveCallCostUsd('gpt-4o', M, 0, M / 2);
    expect(cost).toBeCloseTo(1.875, 8);
  });

  it('prices every table row with all-cached input at its cachedInputPerMTok rate', () => {
    for (const [model, pricing] of MODEL_PRICING.entries()) {
      const cost = deriveCallCostUsd(model, M, 0, M);
      expect(cost).toBeCloseTo(pricing.cachedInputPerMTok ?? pricing.inputPerMTok, 8);
    }
  });

  it('resolves a dated snapshot id against its dateless table row', () => {
    const dated = deriveCallCostUsd('gpt-4o-2024-08-06', M, M, 0);
    const dateless = deriveCallCostUsd('gpt-4o', M, M, 0);
    expect(dated).toBeCloseTo(dateless!, 8);
  });

  it('is case-insensitive on the model id', () => {
    expect(deriveCallCostUsd('GPT-4O', M, 0, 0)).toBeCloseTo(2.5, 8);
  });

  it('prices an o-series reasoning model', () => {
    // o3: $2.00 input + $8.00 output per MTok.
    const cost = deriveCallCostUsd('o3', M, M, 0);
    expect(cost).toBeCloseTo(10.0, 8);
  });

  it('uses the distinct o1-mini rates rather than o3-mini rates', () => {
    const cost = deriveCallCostUsd('o1-mini', M, M, M);
    // $1.50 cached input + $12.00 output per MTok.
    expect(cost).toBeCloseTo(13.5, 8);
  });

  it('prices o1-preview at the same rate as o1 (historical alias)', () => {
    // o1-preview == o1 rates: $15.00 input + $60.00 output per MTok.
    const cost = deriveCallCostUsd('o1-preview', M, M, 0);
    expect(cost).toBeCloseTo(75.0, 8);
  });

  it('prices o1-pro at $150/M input + $600/M output (no cache discount)', () => {
    const cost = deriveCallCostUsd('o1-pro', M, M, 0);
    expect(cost).toBeCloseTo(750.0, 8);
  });
});

describe('deriveCallCostUsd — xAI / Grok fallthrough', () => {
  it('routes grok-4.5 through deriveXaiCallCostUsd (not undefined, not silent $0)', () => {
    // $2 input + $6 output per MTok → $8 for 1M+1M.
    expect(deriveCallCostUsd('grok-4.5', M, M, 0)).toBeCloseTo(8.0, 8);
  });

  it('routes grok-4.6 through deriveXaiCallCostUsd', () => {
    expect(deriveCallCostUsd('grok-4.6', M, M, 0)).toBeCloseTo(8.0, 8);
  });
});

describe('deriveCallCostUsd — unknown model yields unknown, never zero', () => {
  it('returns undefined for a model absent from the table', () => {
    const cost = deriveCallCostUsd('some-model-nobody-has-heard-of', 1000, 1000, 0);
    expect(cost).toBeUndefined();
    // Explicit anti-regression: undefined must never get coerced to 0 by a
    // careless `?? 0` at a call site (issue #866).
    expect(cost).not.toBe(0);
  });

  it('returns undefined for a HuggingFace-style local-shim id (e.g. mlx-community/*)', () => {
    // Deliberate design choice (see pricing.ts module docstring): this
    // provider also serves paid OpenRouter-style `org/model` ids over the
    // identical slash shape, so "unknown" is the safe default for every
    // unlisted id rather than special-casing local runners to a hardcoded 0.
    expect(deriveCallCostUsd('mlx-community/qwen3-30b-a3b-4bit', 1000, 1000, 0)).toBeUndefined();
  });

  it('returns undefined for an empty model string', () => {
    expect(deriveCallCostUsd('', 1000, 1000, 0)).toBeUndefined();
  });
});

describe('deriveCallCostUsd — input clamping', () => {
  it('clamps negative and NaN token counts to zero instead of propagating them', () => {
    const cost = deriveCallCostUsd('gpt-4o', -5, Number.NaN, 0);
    expect(cost).toBe(0);
  });

  it('clamps Infinity token counts to zero (same path as NaN)', () => {
    const cost = deriveCallCostUsd('gpt-4o', Infinity, Infinity, 0);
    expect(cost).toBe(0);
  });

  it('clamps cachedInputTokens to never exceed inputTokens', () => {
    // A malformed usage block claiming more cached than total input tokens
    // must not drive the plain-rate portion negative.
    const overclaimed = deriveCallCostUsd('gpt-4o', 100, 0, 1000);
    const fullyCached = deriveCallCostUsd('gpt-4o', 100, 0, 100);
    expect(overclaimed).toBeCloseTo(fullyCached!, 8);
  });

  it('defaults cachedInputTokens to 0 when omitted', () => {
    const cost = deriveCallCostUsd('gpt-4o', M, 0);
    expect(cost).toBeCloseTo(2.5, 8);
  });
});

describe('deriveCallCostUsd — o3-mini vs o4-mini cache-rate distinction', () => {
  it('o3-mini cachedInputPerMTok is 0.55 (higher than o4-mini)', () => {
    // Rates are intentionally identical for base input/output but differ for cache.
    // This test guards against future "deduplication" of these two table entries.
    const cost = deriveCallCostUsd('o3-mini', M, 0, M); // all-cached
    expect(cost).toBeCloseTo(0.55, 8);
  });

  it('o4-mini cachedInputPerMTok is 0.275 (lower than o3-mini)', () => {
    const cost = deriveCallCostUsd('o4-mini', M, 0, M); // all-cached
    expect(cost).toBeCloseTo(0.275, 8);
  });
});
