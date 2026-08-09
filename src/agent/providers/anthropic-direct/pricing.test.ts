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

describe('deriveCallCostUsd — dated wire ids fall back to dateless rows (#911)', () => {
  // #909 added Opus 4.6/4.7/4.8 and Sonnet 4.6 rows keyed dateless
  // (`claude-opus-4-8`), but the wire ids the API actually sends are dated
  // (`claude-opus-4-8-20260528` — see resolve-effort.test.ts:32,44,49 for the
  // production-verified ids). The exact-match lookup missed those, silently
  // dropping cost for exactly the models the dateless rows were added to
  // price. Each case below pins a dated id against its dateless twin.
  it.each([
    ['claude-opus-4-8', 'claude-opus-4-8-20260528'],
    ['claude-opus-4-7', 'claude-opus-4-7-20250901'],
    ['claude-opus-4-6', 'claude-opus-4-6-20250901'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6-20250901'],
  ])('%s dated as %s resolves to the same defined cost', (dateless, dated) => {
    const datelessCost = deriveCallCostUsd(dateless, M, M, 0, 0);
    const datedCost = deriveCallCostUsd(dated, M, M, 0, 0);
    expect(datelessCost).toBeDefined();
    expect(datedCost).toBeDefined();
    expect(datedCost).toBeCloseTo(datelessCost!, 8);
  });

  it('does not let normalization match an unrelated row', () => {
    // A genuinely unknown model — even one that looks date-suffixed — must
    // still return undefined rather than falling back to some other row.
    expect(deriveCallCostUsd('claude-unknown-99-20260528', 1000, 500, 0, 0)).toBeUndefined();
  });

  it('still returns undefined for an unknown model with no date suffix', () => {
    expect(deriveCallCostUsd('claude-unknown-99', 1000, 500, 0, 0)).toBeUndefined();
  });
});

describe('deriveCallCostUsd — Fast-tier Opus pricing', () => {
  it('prices standard Opus 5 unchanged when no speed is supplied', () => {
    // Guard: the Fast parameter is additive. Every pre-existing caller omits
    // it and must bill exactly what it did before Fast mode existed.
    expect(deriveCallCostUsd('claude-opus-5', M, M, 0, 0)).toBeCloseTo(30.0, 8);
    expect(deriveCallCostUsd('claude-opus-5', M, M, 0, 0, undefined, {})).toBeCloseTo(30.0, 8);
    expect(
      deriveCallCostUsd('claude-opus-5', M, M, 0, 0, undefined, { requestSpeed: 'standard' }),
    ).toBeCloseTo(30.0, 8);
  });

  it('bills Fast-tier Opus 5 at exactly 2x every standard rate', () => {
    // $5/$25 standard -> $10/$50 fast. 1M in + 1M out = $60.
    const fast = deriveCallCostUsd('claude-opus-5', M, M, 0, 0, undefined, {
      requestSpeed: 'fast',
    })!;
    const standard = deriveCallCostUsd('claude-opus-5', M, M, 0, 0)!;
    expect(fast).toBeCloseTo(60.0, 8);
    expect(fast).toBeCloseTo(standard * 2, 8);
  });

  it('doubles cache read and BOTH cache-write TTL rates, not just input/output', () => {
    // Regression guard for the interaction with #915: the Fast multiplier must
    // ride on top of the 5m/1h split rather than collapsing it back to one rate.
    const read = deriveCallCostUsd('claude-opus-5', 0, 0, M, 0, undefined, {
      requestSpeed: 'fast',
    })!;
    expect(read).toBeCloseTo(1.0, 8); // 0.50 standard -> 1.00 fast

    const w5m = deriveCallCostUsd('claude-opus-5', 0, 0, 0, M, { ephemeral5m: M, ephemeral1h: 0 }, {
      requestSpeed: 'fast',
    })!;
    const w1h = deriveCallCostUsd('claude-opus-5', 0, 0, 0, M, { ephemeral5m: 0, ephemeral1h: M }, {
      requestSpeed: 'fast',
    })!;
    expect(w5m).toBeCloseTo(12.5, 8); // 6.25 -> 12.5
    expect(w1h).toBeCloseTo(20.0, 8); // 10.0 -> 20.0
    expect(w1h).toBeGreaterThan(w5m);
  });

  it('bills the cache-creation residual at the doubled 1h rate under Fast', () => {
    // #915's residual rule must survive the Fast multiplier.
    const cost = deriveCallCostUsd('claude-opus-5', 0, 0, 0, 1000, {
      ephemeral5m: 500,
      ephemeral1h: 200,
    }, { requestSpeed: 'fast' })!;
    const expected = (500 / M) * 12.5 + (200 / M) * 20.0 + (300 / M) * 20.0;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('lets the observed response speed override the requested speed', () => {
    // Anthropic may decline a Fast request and serve standard — bill what was
    // served, not what was asked for.
    expect(
      deriveCallCostUsd('claude-opus-5', M, 0, 0, 0, undefined, {
        requestSpeed: 'fast',
        responseSpeed: 'standard',
      }),
    ).toBeCloseTo(5.0, 8);
    expect(
      deriveCallCostUsd('claude-opus-5', M, 0, 0, 0, undefined, {
        requestSpeed: 'standard',
        responseSpeed: 'fast',
      }),
    ).toBeCloseTo(10.0, 8);
  });

  it('applies Fast rates to Opus 4.8, including its dated wire id', () => {
    // Fast eligibility must compose with #914's dated-id fallback.
    expect(
      deriveCallCostUsd('claude-opus-4-8', M, M, 0, 0, undefined, { requestSpeed: 'fast' }),
    ).toBeCloseTo(60.0, 8);
    expect(
      deriveCallCostUsd('claude-opus-4-8-20260528', M, M, 0, 0, undefined, {
        requestSpeed: 'fast',
      }),
    ).toBeCloseTo(60.0, 8);
  });

  it('ignores a fast flag on models Anthropic does not serve on the Fast tier', () => {
    // Only anchored Opus 5 / 4.8 are Fast-eligible. A stray flag must never
    // inflate an ineligible model's cost.
    for (const model of ['claude-sonnet-5', 'claude-opus-4-6', 'claude-opus-4-5-20250929']) {
      const fast = deriveCallCostUsd(model, M, M, 0, 0, undefined, { requestSpeed: 'fast' });
      const standard = deriveCallCostUsd(model, M, M, 0, 0);
      expect(fast, `fast must not change ${model}`).toBeCloseTo(standard!, 8);
    }
  });

  it('still returns undefined for an unknown model asked to price as fast', () => {
    expect(
      deriveCallCostUsd('claude-unknown-99', 1000, 500, 0, 0, undefined, { requestSpeed: 'fast' }),
    ).toBeUndefined();
  });
});
