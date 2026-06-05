/**
 * Unit tests for the pure `shouldAutoCompact` function.
 *
 * No I/O, no mocks — just threshold math and guard conditions.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoCompact, computeUsedTokens, contextWindowTokensUsed, buildContextUsageFields } from './auto-compact.js';

const DEFAULT_THRESHOLD = 0.9;

describe('shouldAutoCompact', () => {
  describe('threshold math at 90%', () => {
    it('returns false when usage is below threshold (89.99%)', () => {
      const limit = 200_000;
      const used = Math.floor(limit * 0.8999);
      expect(shouldAutoCompact(used, limit, DEFAULT_THRESHOLD)).toBe(false);
    });

    it('returns true when usage is exactly at threshold (90.00%)', () => {
      const limit = 200_000;
      const used = limit * 0.9;
      expect(shouldAutoCompact(used, limit, DEFAULT_THRESHOLD)).toBe(true);
    });

    it('returns true when usage exceeds threshold (90.01%)', () => {
      const limit = 200_000;
      const used = Math.ceil(limit * 0.9001);
      expect(shouldAutoCompact(used, limit, DEFAULT_THRESHOLD)).toBe(true);
    });

    it('returns true when usage is at 100%', () => {
      const limit = 200_000;
      expect(shouldAutoCompact(limit, limit, DEFAULT_THRESHOLD)).toBe(true);
    });
  });

  describe('unknown / invalid inputs', () => {
    it('returns false when contextLimit is 0', () => {
      expect(shouldAutoCompact(100_000, 0, DEFAULT_THRESHOLD)).toBe(false);
    });

    it('returns false when contextLimit is negative', () => {
      expect(shouldAutoCompact(100_000, -1, DEFAULT_THRESHOLD)).toBe(false);
    });

    it('returns false when usedTokens is 0', () => {
      expect(shouldAutoCompact(0, 200_000, DEFAULT_THRESHOLD)).toBe(false);
    });

    it('returns false when usedTokens is negative', () => {
      expect(shouldAutoCompact(-1, 200_000, DEFAULT_THRESHOLD)).toBe(false);
    });
  });

  describe('invalid threshold values', () => {
    it('returns false when threshold is 0', () => {
      expect(shouldAutoCompact(200_000, 200_000, 0)).toBe(false);
    });

    it('returns false when threshold is 1 (requires strictly < 1 to not trigger)', () => {
      expect(shouldAutoCompact(200_000, 200_000, 1)).toBe(false);
    });

    it('returns false when threshold is negative', () => {
      expect(shouldAutoCompact(200_000, 200_000, -0.5)).toBe(false);
    });

    it('returns false when threshold is greater than 1', () => {
      expect(shouldAutoCompact(200_000, 200_000, 1.5)).toBe(false);
    });
  });

  describe('custom thresholds', () => {
    it('respects a lower threshold (0.80)', () => {
      const limit = 100_000;
      expect(shouldAutoCompact(80_000, limit, 0.8)).toBe(true);
      expect(shouldAutoCompact(79_999, limit, 0.8)).toBe(false);
    });

    it('respects a higher threshold (0.95)', () => {
      const limit = 100_000;
      expect(shouldAutoCompact(95_000, limit, 0.95)).toBe(true);
      expect(shouldAutoCompact(94_999, limit, 0.95)).toBe(false);
    });
  });

  describe('floating-point edge cases', () => {
    it('handles non-round context limits correctly', () => {
      // 100_001 tokens used out of 111_112 = ~90.001% — should trigger at 0.90
      expect(shouldAutoCompact(100_001, 111_112, DEFAULT_THRESHOLD)).toBe(true);
    });

    it('handles small session token counts', () => {
      // 9 tokens used out of 10 = 90% exactly
      expect(shouldAutoCompact(9, 10, DEFAULT_THRESHOLD)).toBe(true);
      // 8 tokens used out of 10 = 80%
      expect(shouldAutoCompact(8, 10, DEFAULT_THRESHOLD)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// computeUsedTokens is the cumulative billing/fallback formula (input+output).
// It deliberately omits cache — the cache-inclusive context-window footprint is
// computed per-round at the provider and consumed via contextWindowTokensUsed.
// (Cache is omitted HERE because `accumulatedUsage` carries cumulative input but
// last-round cache; mixing the two would double-count. See provider.ts
// ProviderUsage.contextWindowTokens.)
// ---------------------------------------------------------------------------
describe('computeUsedTokens', () => {
  it('returns inputTokens + outputTokens only, ignoring cache fields', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 10_000,
      cacheCreationTokens: 10_000,
    };
    // Must be 200, not 20 200.
    expect(computeUsedTokens(usage)).toBe(200);
  });

  it('handles undefined cache fields (no double-count risk)', () => {
    expect(computeUsedTokens({ inputTokens: 500, outputTokens: 250 })).toBe(750);
  });

  it('returns 0 for an empty usage object', () => {
    expect(computeUsedTokens({})).toBe(0);
  });

  it('treats undefined inputTokens as 0', () => {
    expect(computeUsedTokens({ outputTokens: 42 })).toBe(42);
  });

  it('treats undefined outputTokens as 0', () => {
    expect(computeUsedTokens({ inputTokens: 42 })).toBe(42);
  });

  it('large cache fields do NOT inflate the result', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 100_000,
      cacheCreationTokens: 50_000,
    };
    // Should be 1500, not 151_500.
    expect(computeUsedTokens(usage)).toBe(1_500);
  });
});

describe('contextWindowTokensUsed', () => {
  it('prefers the provider-computed contextWindowTokens when present', () => {
    // Cumulative input (50k) + last-round cache (400k) would mix bases and
    // overcount; the provider footprint (410k) is authoritative.
    const usage = {
      inputTokens: 50_000,
      outputTokens: 10_000,
      cachedInputTokens: 399_000,
      cacheCreationTokens: 1_000,
      contextWindowTokens: 410_000,
    };
    expect(contextWindowTokensUsed(usage)).toBe(410_000);
  });

  it('falls back to inputTokens + outputTokens when contextWindowTokens is absent', () => {
    expect(contextWindowTokensUsed({ inputTokens: 1_000, outputTokens: 300 })).toBe(1_300);
  });

  it('fallback excludes cache (matches computeUsedTokens)', () => {
    const usage = { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 100_000 };
    expect(contextWindowTokensUsed(usage)).toBe(1_500);
  });

  it('returns 0 for an empty usage object', () => {
    expect(contextWindowTokensUsed({})).toBe(0);
  });
});

// buildContextUsageFields is the single source of truth for the camelCase →
// snake_case apiUsage + top-level totalTokens mapping that BOTH providers'
// getContextUsage() returns. Before it existed, /tokens showed "NaNm" total
// (missing totalTokens) and all-zero "Last turn (API)" rows (camelCase apiUsage
// read with snake_case keys).
describe('buildContextUsageFields', () => {
  it('translates camelCase ProviderUsage into snake_case apiUsage', () => {
    const { apiUsage } = buildContextUsageFields({
      inputTokens: 1500,
      outputTokens: 700,
      cachedInputTokens: 3000,
      cacheCreationTokens: 200,
    });
    expect(apiUsage).toEqual({
      input_tokens: 1500,
      output_tokens: 700,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 200,
    });
  });

  it('derives totalTokens from inputTokens + outputTokens (matches the context-% formula, excludes cache)', () => {
    const { totalTokens } = buildContextUsageFields({
      inputTokens: 1500,
      outputTokens: 700,
      cachedInputTokens: 100_000,
      cacheCreationTokens: 50_000,
    });
    // 2200, NOT 152_200 — with no provider footprint present this falls back
    // to inputTokens + outputTokens, staying consistent with the percentage.
    expect(totalTokens).toBe(2200);
  });

  it('uses contextWindowTokens for totalTokens when present (stays consistent with the %)', () => {
    const { totalTokens } = buildContextUsageFields({
      inputTokens: 50_000,
      outputTokens: 10_000,
      cachedInputTokens: 399_000,
      cacheCreationTokens: 1_000,
      contextWindowTokens: 410_000,
    });
    expect(totalTokens).toBe(410_000);
  });

  it('defaults missing per-field counts to 0 (no NaN / undefined leak)', () => {
    const { totalTokens, apiUsage } = buildContextUsageFields({ outputTokens: 42 });
    expect(totalTokens).toBe(42);
    expect(apiUsage).toEqual({
      input_tokens: 0,
      output_tokens: 42,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('returns null apiUsage and zero total when no turn has completed', () => {
    expect(buildContextUsageFields(null)).toEqual({ totalTokens: 0, apiUsage: null });
    expect(buildContextUsageFields(undefined)).toEqual({ totalTokens: 0, apiUsage: null });
  });
});
