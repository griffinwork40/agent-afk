import { describe, expect, it } from 'vitest';
import { sumProviderUsage } from './types.js';
import type { ProviderUsage } from '../../provider.js';

describe('sumProviderUsage', () => {
  const empty: ProviderUsage = { stopReason: null };

  describe('cumulative fields (inputTokens, outputTokens, totalTokens)', () => {
    it('sums input and output tokens across iterations', () => {
      const a: ProviderUsage = { stopReason: 'tool_use', inputTokens: 1000, outputTokens: 200, totalTokens: 1200 };
      const b: ProviderUsage = { stopReason: 'tool_use', inputTokens: 1100, outputTokens: 150, totalTokens: 1250 };
      const result = sumProviderUsage(a, b);
      expect(result.inputTokens).toBe(2100);
      expect(result.outputTokens).toBe(350);
      expect(result.totalTokens).toBe(2450);
    });

    it('treats undefined as 0 when the other side has a value', () => {
      const a: ProviderUsage = { stopReason: null, inputTokens: 500 };
      const b: ProviderUsage = { stopReason: null };
      const result = sumProviderUsage(a, b);
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBeUndefined();
    });
  });

  describe('cache fields use latest-wins (not sum)', () => {
    it('takes b.cachedInputTokens over a.cachedInputTokens', () => {
      const a: ProviderUsage = { stopReason: 'tool_use', cachedInputTokens: 50_000 };
      const b: ProviderUsage = { stopReason: 'tool_use', cachedInputTokens: 52_000 };
      const result = sumProviderUsage(a, b);
      expect(result.cachedInputTokens).toBe(52_000);
    });

    it('takes b.cacheCreationTokens over a.cacheCreationTokens', () => {
      const a: ProviderUsage = { stopReason: 'tool_use', cacheCreationTokens: 10_000 };
      const b: ProviderUsage = { stopReason: 'tool_use', cacheCreationTokens: 0 };
      const result = sumProviderUsage(a, b);
      expect(result.cacheCreationTokens).toBe(0);
    });

    it('preserves a when b is undefined', () => {
      const a: ProviderUsage = { stopReason: 'tool_use', cachedInputTokens: 50_000, cacheCreationTokens: 5_000 };
      const b: ProviderUsage = { stopReason: 'tool_use' };
      const result = sumProviderUsage(a, b);
      expect(result.cachedInputTokens).toBe(50_000);
      expect(result.cacheCreationTokens).toBe(5_000);
    });

    it('omits cache fields when both sides are undefined', () => {
      const result = sumProviderUsage(empty, empty);
      expect(result.cachedInputTokens).toBeUndefined();
      expect(result.cacheCreationTokens).toBeUndefined();
    });
  });

  describe('multi-iteration accumulation (simulates N tool-use rounds)', () => {
    it('does not inflate cache tokens across 5 iterations', () => {
      const cachePerIteration = 80_000;
      let accumulated: ProviderUsage = { stopReason: null };

      for (let i = 0; i < 5; i++) {
        const iteration: ProviderUsage = {
          stopReason: 'tool_use',
          inputTokens: 2000 + i * 100,
          outputTokens: 300,
          cachedInputTokens: cachePerIteration,
          cacheCreationTokens: 0,
        };
        accumulated = sumProviderUsage(accumulated, iteration);
      }

      expect(accumulated.cachedInputTokens).toBe(cachePerIteration);
      expect(accumulated.cacheCreationTokens).toBe(0);
      expect(accumulated.inputTokens).toBe(2000 + 2100 + 2200 + 2300 + 2400);
    });
  });

  describe('stopReason', () => {
    it('prefers b.stopReason', () => {
      const a: ProviderUsage = { stopReason: 'tool_use' };
      const b: ProviderUsage = { stopReason: 'end_turn' };
      expect(sumProviderUsage(a, b).stopReason).toBe('end_turn');
    });

    it('falls back to a.stopReason when b is null', () => {
      const a: ProviderUsage = { stopReason: 'tool_use' };
      const b: ProviderUsage = { stopReason: null };
      expect(sumProviderUsage(a, b).stopReason).toBe('tool_use');
    });
  });
});
