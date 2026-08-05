/**
 * Unit tests for the prompt-cache-aware pricing model.
 *
 * Every assertion here is a golden pinned against Anthropic's published
 * rates (https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing,
 * verified 2026-08-05). A wrong rate fails silently and persists into saved
 * cost reports, so these are exact values rather than "cost > 0".
 *
 * @module agent/providers/anthropic-direct/pricing.test
 */

import { describe, it, expect } from 'vitest';
import { deriveCallCostUsd, MODEL_PRICING } from './pricing.js';

const M = 1_000_000;

describe('deriveCallCostUsd — cache-write TTL rates', () => {
  it('prices a 1h cache write at 2x base input, not the 5m 1.25x', () => {
    // Regression: the rate was hardcoded at 1.25x (the 5-minute rate) while
    // cache-policy.ts defaults AFK_PROMPT_CACHE_TTL to '1h', understating the
    // write component of every cached session by 37.5%.
    // sonnet-5: $3 base → 5m write $3.75, 1h write $6.00.
    const at5m = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, M, {
      ephemeral5m: M,
      ephemeral1h: 0,
    });
    const at1h = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, M, {
      ephemeral5m: 0,
      ephemeral1h: M,
    });
    expect(at5m).toBeCloseTo(3.75, 8);
    expect(at1h).toBeCloseTo(6.0, 8);
    // The whole point: 1h costs strictly more. Guards against a future edit
    // that collapses both branches back to one rate.
    expect(at1h!).toBeGreaterThan(at5m!);
  });

  it('bills a mixed-TTL call by segment rather than picking one rate', () => {
    // The API bills 1h and 5m segments separately when breakpoints mix TTLs.
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, M, {
      ephemeral5m: M / 2,
      ephemeral1h: M / 2,
    });
    expect(cost).toBeCloseTo(0.5 * 3.75 + 0.5 * 6.0, 8);
  });

  it('defaults to the 5m rate when no TTL split is supplied', () => {
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, M);
    expect(cost).toBeCloseTo(3.75, 8);
  });

  it('derives both write rates from base input when a row omits them', () => {
    // Rows may omit explicit cache rates; the 1.25x / 2x multipliers apply.
    const rows = [...MODEL_PRICING.entries()];
    for (const [model, p] of rows) {
      const oneHour = deriveCallCostUsd(model, 0, 0, 0, M, {
        ephemeral5m: 0,
        ephemeral1h: M,
      });
      const expected = p.cacheWrite1hPerMTok ?? p.inputPerMTok * 2;
      expect(oneHour, `1h write rate for ${model}`).toBeCloseTo(expected, 8);
    }
  });
});

describe('deriveCallCostUsd — cache-creation residual outside known TTL buckets', () => {
  it('bills the residual at the 1h rate instead of dropping it (issue #912)', () => {
    // cacheCreationTokens (1000) exceeds ephemeral5m+ephemeral1h (700) by 300 —
    // a hypothetical third TTL tier the two known buckets don't cover. Before
    // the fix, those 300 tokens cost $0 with no error anywhere.
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, 1000, {
      ephemeral5m: 500,
      ephemeral1h: 200,
    })!;
    const expected = (500 / M) * 3.75 + (200 / M) * 6.0 + (300 / M) * 6.0;
    expect(cost).toBeCloseTo(expected, 8);
    // Equivalent: the residual is billed at the same rate as an explicit 1h
    // write of the same size (300 tokens), confirming which rate was used.
    const explicit1hOnly = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, 700, {
      ephemeral5m: 500,
      ephemeral1h: 200,
    })!;
    expect(cost - explicit1hOnly).toBeCloseTo((300 / M) * 6.0, 8);
  });

  it('is unchanged when the split already sums to the full total (regression guard)', () => {
    // A consistent split (today's only reachable shape, per the SDK's
    // required, non-nullable CacheCreation fields) must cost exactly what it
    // did before the residual logic was added.
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, 1000, {
      ephemeral5m: 600,
      ephemeral1h: 400,
    });
    const expected = (600 / M) * 3.75 + (400 / M) * 6.0;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('does not double-bill when no split is supplied and the fallback already equals the total', () => {
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, 1000);
    expect(cost).toBeCloseTo((1000 / M) * 3.75, 8);
  });

  it('negative token counts do not produce a negative cost', () => {
    const cost = deriveCallCostUsd('claude-sonnet-5', -1000, -500, -200, -300)!;
    expect(cost).toBe(0);
    expect(cost).not.toBeLessThan(0);
  });

  it('NaN token counts do not produce a NaN cost', () => {
    const cost = deriveCallCostUsd('claude-sonnet-5', NaN, 500, 0, 0)!;
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBeCloseTo((500 / M) * 15.0, 8);
  });

  it('a negative or NaN split field does not poison the residual or go negative', () => {
    const cost = deriveCallCostUsd('claude-sonnet-5', 0, 0, 0, 1000, {
      ephemeral5m: NaN,
      ephemeral1h: -200,
    })!;
    // Both split fields clamp to 0, so the full 1000 becomes residual, billed
    // at the 1h rate — and the result must be finite and non-negative.
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).not.toBeLessThan(0);
    expect(cost).toBeCloseTo((1000 / M) * 6.0, 8);
  });
});

describe('deriveCallCostUsd — plain input is cache-exclusive', () => {
  it('does not subtract cache counts from input_tokens', () => {
    // Per the Messages API docs, `input_tokens` counts only tokens neither
    // read from nor used to create a cache. The old code subtracted both off
    // it again and clamped at zero — so in a warm session (cache_read >>
    // input) the plain-input term silently vanished.
    const cost = deriveCallCostUsd('claude-sonnet-5', 1000, 0, 100_000, 0);
    const expectedPlain = (1000 / M) * 3.0;
    const expectedRead = (100_000 / M) * 0.3;
    expect(cost).toBeCloseTo(expectedPlain + expectedRead, 8);
  });

  it('keeps the plain-input term when cache counts dwarf it', () => {
    // The clamping bug's signature: cost identical with and without a huge
    // cache_read would mean plain input was being zeroed out.
    const withCache = deriveCallCostUsd('claude-sonnet-5', 500, 0, 200_000, 0)!;
    const readOnly = deriveCallCostUsd('claude-sonnet-5', 0, 0, 200_000, 0)!;
    expect(withCache - readOnly).toBeCloseTo((500 / M) * 3.0, 8);
  });
});

describe('deriveCallCostUsd — published rate goldens', () => {
  it('opus-4-5 uses $5/$25, not the retired opus-4.1 $15/$75', () => {
    // Regression: the 4.5 row carried the retired Opus 4.1/4.0 rates,
    // overstating every Opus 4.5 cost report 3x. Same copy-paste class as the
    // Haiku 3.5 -> 4.5 mixup. 1M in + 1M out = $5 + $25 = $30.
    const cost = deriveCallCostUsd('claude-opus-4-5-20250929', M, M, 0, 0);
    expect(cost).toBeCloseTo(30.0, 8);
  });

  it('opus-5 uses the published $5.00/$25.00 rates', () => {
    expect(deriveCallCostUsd('claude-opus-5', M, M, 0, 0)).toBeCloseTo(30.0, 8);
  });

  it('returns undefined for an unknown model rather than zero', () => {
    expect(deriveCallCostUsd('claude-unknown-99', 1000, 500, 0, 0)).toBeUndefined();
  });

  it('every table row produces a positive cost for non-zero tokens', () => {
    for (const [model] of MODEL_PRICING) {
      const cost = deriveCallCostUsd(model, 1000, 500, 0, 0);
      expect(cost, `cost for ${model}`).toBeDefined();
      expect(cost!, `cost for ${model}`).toBeGreaterThan(0);
    }
  });

  it('every table row prices a 1h write above a 5m write', () => {
    for (const [model] of MODEL_PRICING) {
      const w5 = deriveCallCostUsd(model, 0, 0, 0, M, { ephemeral5m: M, ephemeral1h: 0 })!;
      const w1 = deriveCallCostUsd(model, 0, 0, 0, M, { ephemeral5m: 0, ephemeral1h: M })!;
      expect(w1, `1h vs 5m for ${model}`).toBeGreaterThan(w5);
    }
  });
});
