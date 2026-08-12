/**
 * Tests for the context-window overflow guard and safe auto-compact threshold
 * introduced by #962.
 *
 * `guardContextOverflow` — fail-fast error before the wire call when input
 * tokens + max_tokens already exceeds the context window.
 *
 * `safeAutoCompactThresholdFor` — computes the maximum threshold at which
 * auto-compaction can fire and still leave headroom for a full output turn.
 *
 * `resolveAutoCompactThreshold` — extended with an optional `model` param
 * that caps the resolved threshold at the safe boundary.
 */

import { describe, it, expect } from 'vitest';
import { guardContextOverflow, safeAutoCompactThresholdFor, resolveAutoCompactThreshold } from './auto-compact.js';

// ─── guardContextOverflow ──────────────────────────────────────────────────

describe('guardContextOverflow', () => {
  describe('throws when overflow is certain', () => {
    it('haiku overflow: 137k input + 64k output > 200k window', () => {
      // Real scenario: haiku 200k window, 64k output ceiling.
      // 137k + 64k = 201k > 200k → must throw.
      expect(() =>
        guardContextOverflow(137_000, 64_000, 200_000, 'haiku'),
      ).toThrow(/Context-window overflow/);
    });

    it('error message names the numbers', () => {
      const err = (() => {
        try {
          guardContextOverflow(140_000, 64_000, 200_000, 'haiku');
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).not.toBeNull();
      expect(err!.message).toContain('140,000');
      expect(err!.message).toContain('64,000');
      expect(err!.message).toContain('200,000');
      expect(err!.message).toContain('haiku');
      // Overflow amount: 140k + 64k - 200k = 4k
      expect(err!.message).toContain('4,000');
    });

    it('error message mentions /compact and new session escape hatches', () => {
      let err: Error | null = null;
      try {
        guardContextOverflow(150_000, 64_000, 200_000, 'haiku');
      } catch (e) {
        err = e as Error;
      }
      expect(err!.message).toContain('/compact');
      expect(err!.message).toContain('new session');
    });

    it('openai-compatible fallback: 200k + 64k > 262k', () => {
      expect(() =>
        guardContextOverflow(200_000, 64_000, 262_144, 'gpt-4o'),
      ).toThrow(/Context-window overflow/);
    });

    it('throws when input + output equals context limit + 1 (exact boundary)', () => {
      // 136k + 64k = 200k is exactly at the limit — does NOT throw.
      // 136k + 64k + 1 > 200k — must throw.
      expect(() =>
        guardContextOverflow(136_001, 64_000, 200_000, 'haiku'),
      ).toThrow(/Context-window overflow/);
    });
  });

  describe('does NOT throw when overflow is not certain', () => {
    it('no usage yet (first turn): knownInputTokens = 0', () => {
      // First turn: lastUsage is null, so knownInputTokens = 0.
      // Guard must not throw — we have no lower bound.
      expect(() =>
        guardContextOverflow(0, 64_000, 200_000, 'haiku'),
      ).not.toThrow();
    });

    it('input + output exactly at the context limit (136k + 64k = 200k)', () => {
      // Exactly at the limit — NOT over, so no throw.
      expect(() =>
        guardContextOverflow(136_000, 64_000, 200_000, 'haiku'),
      ).not.toThrow();
    });

    it('safe with headroom (100k input + 64k output < 200k)', () => {
      expect(() =>
        guardContextOverflow(100_000, 64_000, 200_000, 'haiku'),
      ).not.toThrow();
    });

    it('large context model with headroom (800k + 128k < 1M)', () => {
      expect(() =>
        guardContextOverflow(800_000, 128_000, 1_000_000, 'claude-sonnet-5'),
      ).not.toThrow();
    });

    it('skips guard when contextLimit is 0 (unknown)', () => {
      expect(() =>
        guardContextOverflow(150_000, 64_000, 0, 'unknown-model'),
      ).not.toThrow();
    });

    it('skips guard when maxOutputTokens is 0', () => {
      expect(() =>
        guardContextOverflow(150_000, 0, 200_000, 'haiku'),
      ).not.toThrow();
    });

    it('skips guard when knownInputTokens is negative', () => {
      expect(() =>
        guardContextOverflow(-1, 64_000, 200_000, 'haiku'),
      ).not.toThrow();
    });
  });
});

// ─── safeAutoCompactThresholdFor ──────────────────────────────────────────

describe('safeAutoCompactThresholdFor', () => {
  it('returns a threshold strictly below the overflow point for haiku', () => {
    // Haiku: 200k window, 64k ceiling → overflow at 136k/200k = 0.68.
    // Safe threshold must be < 0.68 so compaction fires before overflow.
    const t = safeAutoCompactThresholdFor('haiku');
    expect(t).toBeLessThan(0.68);
    expect(t).toBeGreaterThan(0);
  });

  it('returns a value in (0, 1) for known models', () => {
    for (const model of ['haiku', 'claude-sonnet-5', 'claude-opus-5', 'gpt-4o']) {
      const t = safeAutoCompactThresholdFor(model);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('returns a higher threshold for 1M-opt-in aliases vs haiku', () => {
    // sonnet_1m bypasses the budget → autoCompactLimitFor = contextLimitFor = 1M.
    // 1M window, 128k ceiling → (872k/1M) - slack ≈ 0.832.
    // haiku: 200k window, 64k ceiling → (136k/200k) - slack ≈ 0.64.
    // So sonnet_1m safe threshold > haiku safe threshold.
    const haikuT = safeAutoCompactThresholdFor('haiku');
    const sonnetT = safeAutoCompactThresholdFor('sonnet_1m');
    expect(sonnetT).toBeGreaterThan(haikuT);
  });

  it('returns DEFAULT_AUTO_COMPACT_THRESHOLD for models with a budget-based compaction limit', () => {
    // Base sonnet/opus have a budget < contextWindow → no cap needed → default 0.9.
    expect(safeAutoCompactThresholdFor('claude-sonnet-5')).toBe(0.9);
    expect(safeAutoCompactThresholdFor('claude-opus-5')).toBe(0.9);
  });

  it('returns a threshold that keeps compaction below the overflow point', () => {
    // For any model, safeThreshold × window + ceiling must be ≤ window.
    // (i.e. safeThreshold ≤ (window - ceiling) / window)
    // We test haiku explicitly.
    const window = 200_000;
    const ceiling = 64_000;
    const t = safeAutoCompactThresholdFor('haiku');
    const wouldCompactAt = t * window;
    // Compaction trigger + output ceiling must not exceed the window.
    expect(wouldCompactAt + ceiling).toBeLessThanOrEqual(window);
  });
});

// ─── resolveAutoCompactThreshold (with model cap) ─────────────────────────

describe('resolveAutoCompactThreshold — model-aware safe cap (#962)', () => {
  it('caps the default 0.9 threshold for haiku below the overflow point', () => {
    const t = resolveAutoCompactThreshold(true, 'haiku');
    // Safe threshold for haiku is ~0.64; must be below 0.68 (overflow point).
    expect(t).not.toBeUndefined();
    expect(t!).toBeLessThan(0.68);
  });

  it('does not raise a user-configured lower threshold', () => {
    // A user who explicitly sets 0.5 should keep 0.5, even if safe cap is 0.64.
    const t = resolveAutoCompactThreshold({ threshold: 0.5 }, 'haiku');
    expect(t).toBe(0.5);
  });

  it('caps a user-configured threshold that is above the safe boundary', () => {
    // A user who sets 0.85 on haiku (> safe cap of ~0.64) gets the safe cap.
    const t = resolveAutoCompactThreshold({ threshold: 0.85 }, 'haiku');
    expect(t).not.toBeUndefined();
    expect(t!).toBeLessThan(0.68); // must be at or below safe boundary
  });

  it('returns undefined when autoCompact is false (no model)', () => {
    expect(resolveAutoCompactThreshold(false)).toBeUndefined();
    expect(resolveAutoCompactThreshold(false, 'haiku')).toBeUndefined();
  });

  it('returns undefined when autoCompact is undefined', () => {
    expect(resolveAutoCompactThreshold(undefined)).toBeUndefined();
    expect(resolveAutoCompactThreshold(undefined, 'haiku')).toBeUndefined();
  });

  it('does NOT cap base sonnet (has a budget-based compaction limit, already safe)', () => {
    // base sonnet: MODEL_AUTOCOMPACT_BUDGET shrinks compaction limit to 200k,
    // far below the 1M overflow boundary. safeAutoCompactThresholdFor returns
    // the default 0.9 for these models — no additional cap needed.
    const t = resolveAutoCompactThreshold(true, 'claude-sonnet-5');
    expect(t).toBe(0.9);
  });

  it('caps the 1M opt-in alias (sonnet_1m) below 0.9', () => {
    // sonnet_1m bypasses the budget (autoCompactLimitFor = contextLimitFor = 1M).
    // 1M window, 128k ceiling → safe cap = (872k/1M) - 0.04 = 0.832.
    // The default 0.9 is capped to 0.832.
    const t = resolveAutoCompactThreshold(true, 'sonnet_1m');
    expect(t).not.toBeUndefined();
    expect(t!).toBeGreaterThan(0.8);
    expect(t!).toBeLessThan(0.9);
  });

  it('still works without a model argument (backward-compatible)', () => {
    // Without a model, no cap is applied — existing behaviour unchanged.
    const t = resolveAutoCompactThreshold(true);
    expect(t).toBe(0.9);
    const t2 = resolveAutoCompactThreshold({ threshold: 0.8 });
    expect(t2).toBe(0.8);
  });
});
