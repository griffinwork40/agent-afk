/**
 * Unit tests for toProviderUsage, deriveCallCostUsd, and sumProviderUsage
 * (C6 fix: populate totalCostUsd from model pricing table).
 *
 * @module agent/providers/anthropic-direct/types.test
 */

import { describe, it, expect } from 'vitest';
import {
  toProviderUsage,
  sumProviderUsage,
  deriveCallCostUsd,
  MODEL_PRICING,
} from './types.js';
import type { Usage } from '@anthropic-ai/sdk/resources';

// Minimal Usage stub — the real SDK type has optional fields.
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    ...overrides,
  } as unknown as Usage;
}

describe('deriveCallCostUsd', () => {
  it('returns a number for a known model', () => {
    const cost = deriveCallCostUsd('claude-sonnet-4-5-20250929', 1000, 500, 0, 0);
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown model', () => {
    const cost = deriveCallCostUsd('claude-unknown-99', 1000, 500, 0, 0);
    expect(cost).toBeUndefined();
  });

  it('computes a correct estimate for sonnet: 1000 in, 500 out', () => {
    // claude-sonnet-4-5-20250929: $3.00/MTok input, $15.00/MTok output
    const expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0;
    const cost = deriveCallCostUsd('claude-sonnet-4-5-20250929', 1000, 500, 0, 0);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('accounts for cache-read tokens at a discounted rate', () => {
    // Plain input = 1000 - 200 cached = 800; cache-read: 200 at 0.30/MTok
    const plain = (800 / 1_000_000) * 3.0;
    const cacheRead = (200 / 1_000_000) * 0.30;
    const output = (100 / 1_000_000) * 15.0;
    const expected = plain + cacheRead + output;
    const cost = deriveCallCostUsd('claude-sonnet-4-5-20250929', 1000, 100, 200, 0);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('accounts for cache-creation tokens at a premium rate', () => {
    // Plain input = 1000 - 300 cache-creation = 700; cache-write: 300 at 3.75/MTok
    const plain = (700 / 1_000_000) * 3.0;
    const cacheWrite = (300 / 1_000_000) * 3.75;
    const output = (50 / 1_000_000) * 15.0;
    const expected = plain + cacheWrite + output;
    const cost = deriveCallCostUsd('claude-sonnet-4-5-20250929', 1000, 50, 0, 300);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('all models in the pricing table produce a positive cost for non-zero tokens', () => {
    for (const [model] of MODEL_PRICING) {
      const cost = deriveCallCostUsd(model, 1000, 500, 0, 0);
      expect(cost, `cost for ${model}`).toBeDefined();
      expect(cost!, `cost for ${model}`).toBeGreaterThan(0);
    }
  });

  it('haiku-4-5 uses the corrected $1.00/$5.00 rates (not stale 3.5 $0.80/$4.00)', () => {
    // Phase 1.5: the previous Haiku 4.5 entry copied the Haiku 3.5 prices
    // ($0.80/$4.00 per MTok), under-reporting per-turn cost by ~20%. Public
    // pricing per https://www.anthropic.com/pricing is $1.00/$5.00. Golden
    // value: 1M input + 1M output = $1.00 + $5.00 = $6.00.
    const cost = deriveCallCostUsd('claude-haiku-4-5-20250929', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(6.0, 8);

    // Spot-check the 20251001 alias matches.
    const cost2 = deriveCallCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000, 0, 0);
    expect(cost2).toBeCloseTo(6.0, 8);

    // Haiku 3.5 remains at the original $0.80/$4.00 → 1M+1M = $4.80.
    const cost35 = deriveCallCostUsd('claude-3-5-haiku-20241022', 1_000_000, 1_000_000, 0, 0);
    expect(cost35).toBeCloseTo(4.8, 8);
  });
});

describe('toProviderUsage — with model', () => {
  it('populates totalCostUsd when model is known', () => {
    const usage = makeUsage({ input_tokens: 1000, output_tokens: 500 });
    const out = toProviderUsage(usage, 'end_turn', 'claude-sonnet-4-5-20250929');
    expect(typeof out.totalCostUsd).toBe('number');
    expect(out.totalCostUsd!).toBeGreaterThan(0);
  });

  it('leaves totalCostUsd undefined when model is unknown', () => {
    const usage = makeUsage({ input_tokens: 1000, output_tokens: 500 });
    const out = toProviderUsage(usage, 'end_turn', 'model-unknown-99');
    expect(out.totalCostUsd).toBeUndefined();
  });

  it('leaves totalCostUsd undefined when model is not passed', () => {
    const usage = makeUsage({ input_tokens: 1000, output_tokens: 500 });
    const out = toProviderUsage(usage, 'end_turn');
    expect(out.totalCostUsd).toBeUndefined();
  });

  it('still returns correct token counts with a model', () => {
    const usage = makeUsage({ input_tokens: 1000, output_tokens: 500 });
    const out = toProviderUsage(usage, 'end_turn', 'claude-sonnet-4-5-20250929');
    expect(out.inputTokens).toBe(1000);
    expect(out.outputTokens).toBe(500);
    expect(out.totalTokens).toBe(1500);
  });

  it('returns empty ProviderUsage when usage is null', () => {
    const out = toProviderUsage(null, 'end_turn', 'claude-sonnet-4-5-20250929');
    expect(out.totalCostUsd).toBeUndefined();
    expect(out.inputTokens).toBeUndefined();
  });
});

describe('sumProviderUsage — totalCostUsd accumulation', () => {
  it('sums totalCostUsd from two usages', () => {
    const a = toProviderUsage(
      makeUsage({ input_tokens: 500, output_tokens: 200 }),
      'tool_use',
      'claude-sonnet-4-5-20250929',
    );
    const b = toProviderUsage(
      makeUsage({ input_tokens: 600, output_tokens: 300 }),
      'end_turn',
      'claude-sonnet-4-5-20250929',
    );
    const sum = sumProviderUsage(a, b);
    expect(typeof sum.totalCostUsd).toBe('number');
    expect(sum.totalCostUsd).toBeCloseTo((a.totalCostUsd ?? 0) + (b.totalCostUsd ?? 0), 8);
  });

  it('leaves totalCostUsd undefined when both inputs have no cost', () => {
    const a = toProviderUsage(makeUsage(), 'tool_use'); // no model → no cost
    const b = toProviderUsage(makeUsage(), 'end_turn'); // no model → no cost
    const sum = sumProviderUsage(a, b);
    expect(sum.totalCostUsd).toBeUndefined();
  });

  it('carries cost from a when b has no cost', () => {
    const a = toProviderUsage(
      makeUsage({ input_tokens: 100, output_tokens: 50 }),
      'tool_use',
      'claude-sonnet-4-5-20250929',
    );
    const b = toProviderUsage(makeUsage(), 'end_turn'); // no model
    const sum = sumProviderUsage(a, b);
    expect(sum.totalCostUsd).toBeCloseTo(a.totalCostUsd ?? 0, 8);
  });
});
