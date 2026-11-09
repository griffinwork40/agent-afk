/**
 * Claude Fable 5.2 (successor to Fable 5.1) onboarding contract.
 *
 * Breaking constraints (same profile as Fable 5.1):
 *   1. Adaptive thinking is always on — `{type:'enabled'}` and `{type:'disabled'}` → 400.
 *   2. Non-default temperature/top_p/top_k → 400.
 *   3. Forced tool use (`tool_choice: any/tool`) → 400 (AFK never sends this).
 *   4. Thinking blocks are prefix-bound — editing prior turns invalidates them.
 *
 * Wire IDs under test:
 *   - `claude-fable-5-2`  (GA, all customers)
 *
 * Pricing: $8 input / $40 output per MTok; cache write 5m: $10, 1h: $16, read: $0.20.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isFable52,
  resolveEffort,
  resolveThinkingParam,
  resolveAnthropicTemperature,
  isNonDefaultSamplingForbiddenModel,
  _resetWarnedTemperatureClampsForTest,
} from './resolve-params.js';
import { deriveCallCostUsd } from './pricing.js';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';
import { CLAUDE_FABLE_5_2_ID, DIRECT_MODEL_ALIASES } from '../../session/model-slots.js';

const ID = 'claude-fable-5-2';
const M = 1_000_000;

// ── Model-ID constant and alias wiring ────────────────────────────────────

describe('Fable 5.2 model-slot constant', () => {
  it('CLAUDE_FABLE_5_2_ID is the expected wire id', () => {
    expect(CLAUDE_FABLE_5_2_ID).toBe(ID);
  });

  it('DIRECT_MODEL_ALIASES fable → claude-fable-5-2', () => {
    expect(DIRECT_MODEL_ALIASES['fable']).toBe(ID);
  });

  it('DIRECT_MODEL_ALIASES does NOT include a fable-5-2 key (raw id passes through)', () => {
    expect(DIRECT_MODEL_ALIASES[ID]).toBeUndefined();
  });
});

// ── Context window and output limits ──────────────────────────────────────

describe('Fable 5.2 limits', () => {
  it('reports the native 1M context window and 128K output cap', () => {
    expect(contextLimitFor(ID)).toBe(1_000_000);
    expect(maxOutputTokensFor(ID)).toBe(128_000);
  });

  it('uses the full 1M window for auto-compaction (no reduced working budget)', () => {
    expect(autoCompactLimitFor(ID)).toBe(1_000_000);
  });

  it('fable alias also reports 1M context and 128K output', () => {
    expect(contextLimitFor('fable')).toBe(1_000_000);
    expect(maxOutputTokensFor('fable')).toBe(128_000);
  });
});

// ── Pricing: $8/$40 per MTok, reduced from Fable 5.1 ─────────────────────

describe('Fable 5.2 pricing', () => {
  it('prices at $8 input / $40 output per MTok', () => {
    expect(deriveCallCostUsd(ID, M, 0, 0, 0)).toBeCloseTo(8.0, 8);
    expect(deriveCallCostUsd(ID, 0, M, 0, 0)).toBeCloseTo(40.0, 8);
  });

  it('prices cache reads at $0.20/MTok', () => {
    expect(deriveCallCostUsd(ID, 0, 0, M, 0)).toBeCloseTo(0.20, 8);
  });

  it('prices 5-minute cache writes at $10/MTok', () => {
    expect(deriveCallCostUsd(ID, 0, 0, 0, M)).toBeCloseTo(10.0, 8);
  });

  it('prices 1-hour cache writes at $16/MTok', () => {
    expect(
      deriveCallCostUsd(ID, 0, 0, 0, M, { ephemeral5m: 0, ephemeral1h: M }),
    ).toBeCloseTo(16.0, 8);
  });

  it('Fable 5.1 pricing is preserved for back-compat ($10/$50)', () => {
    expect(deriveCallCostUsd('claude-fable-5-1', M, 0, 0, 0)).toBeCloseTo(10.0, 8);
    expect(deriveCallCostUsd('claude-fable-5-1', 0, M, 0, 0)).toBeCloseTo(50.0, 8);
  });
});

// ── Effort default ────────────────────────────────────────────────────────

describe('Fable 5.2 effort default', () => {
  it('defaults to "high" (not "max")', () => {
    expect(resolveEffort(undefined, ID)).toBe('high');
    expect(resolveEffort(undefined, `${ID}-20261109`)).toBe('high');
  });

  it('passes explicit effort through unchanged', () => {
    expect(resolveEffort('max', ID)).toBe('max');
    expect(resolveEffort('low', ID)).toBe('low');
    expect(resolveEffort('medium', ID)).toBe('medium');
  });

  it('does not affect Fable 5 (which gets the fallback default, not "high")', () => {
    expect(resolveEffort(undefined, 'claude-fable-5')).toBeUndefined();
  });
});

// ── Thinking: always adaptive — enabled and disabled → 400 ───────────────

describe('Fable 5.2 thinking constraints', () => {
  it('promotes enabled to adaptive (API rejects {type:"enabled"} with HTTP 400)', () => {
    const result = resolveThinkingParam({ type: 'enabled' }, 64_000, ID) as {
      type: string;
      budget_tokens?: number;
    };
    expect(result.type).toBe('adaptive');
    expect(result.budget_tokens).toBeUndefined();
  });

  it('throws a legible error for disabled (API rejects {type:"disabled"} at every effort)', () => {
    expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID)).toThrow(
      /fable-5-2.*adaptive thinking.*cannot be disabled/,
    );
  });

  it('throws the same error for disabled regardless of effort level', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toThrow(
        /fable-5-2/,
      );
    }
  });

  it('passes adaptive through unchanged (the correct explicit choice)', () => {
    const result = resolveThinkingParam({ type: 'adaptive' }, 64_000, ID);
    expect(result).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('does NOT affect Fable 5 (which supports {type:"enabled"} extended thinking)', () => {
    const result = resolveThinkingParam({ type: 'enabled' }, 64_000, 'claude-fable-5') as {
      type: string;
      budget_tokens?: number;
    };
    expect(result.type).toBe('enabled');
    expect(result.budget_tokens).toBeGreaterThan(0);
  });
});

// ── Non-default sampling forbidden ───────────────────────────────────────

describe('Fable 5.2 non-default sampling', () => {
  it('isNonDefaultSamplingForbiddenModel returns true for claude-fable-5-2', () => {
    expect(isNonDefaultSamplingForbiddenModel(ID)).toBe(true);
    expect(isNonDefaultSamplingForbiddenModel(`${ID}-20261109`)).toBe(true);
  });

  it('resolveAnthropicTemperature returns undefined for fable-5-2 (drops any value)', () => {
    expect(resolveAnthropicTemperature(0.5, ID)).toBeUndefined();
    expect(resolveAnthropicTemperature(1.0, ID)).toBeUndefined();
    expect(resolveAnthropicTemperature(0.0, ID)).toBeUndefined();
  });

  it('isNonDefaultSamplingForbiddenModel returns false for Fable 5', () => {
    expect(isNonDefaultSamplingForbiddenModel('claude-fable-5')).toBe(false);
  });

  it('isNonDefaultSamplingForbiddenModel returns true for Fable 5.1 (unchanged)', () => {
    expect(isNonDefaultSamplingForbiddenModel('claude-fable-5-1')).toBe(true);
  });
});

// ── isFable52 regex boundary ──────────────────────────────────────────────
// The regex must NOT match fable-5-20, fable-5-21, or any hypothetical
// fable-5-2x suffix — only fable-5-2 terminated by a non-identifier char or EOS.

describe('isFable52 regex boundary', () => {
  // Must MATCH
  it('matches claude-fable-5-2 (canonical wire id)', () => {
    expect(isFable52('claude-fable-5-2')).toBe(true);
  });

  it('matches fable-5-2 (without claude- prefix)', () => {
    expect(isFable52('fable-5-2')).toBe(true);
  });

  it('matches claude-fable-5-2-20261109 (dated release)', () => {
    expect(isFable52('claude-fable-5-2-20261109')).toBe(true);
  });

  it('matches claude-fable-5-2@beta (at-sign separator)', () => {
    expect(isFable52('claude-fable-5-2@beta')).toBe(true);
  });

  it('matches claude-fable-5-2.0 (dot separator)', () => {
    expect(isFable52('claude-fable-5-2.0')).toBe(true);
  });

  // Must NOT MATCH
  it('does NOT match claude-fable-5-20', () => {
    expect(isFable52('claude-fable-5-20')).toBe(false);
  });

  it('does NOT match fable-5-21', () => {
    expect(isFable52('fable-5-21')).toBe(false);
  });

  it('does NOT match claude-fable-5-2x', () => {
    expect(isFable52('claude-fable-5-2x')).toBe(false);
  });

  it('does NOT match claude-fable-5-1 (sibling model)', () => {
    expect(isFable52('claude-fable-5-1')).toBe(false);
  });

  it('isNonDefaultSamplingForbiddenModel is false for fable-5-20', () => {
    expect(isNonDefaultSamplingForbiddenModel('claude-fable-5-20')).toBe(false);
  });

  it('isNonDefaultSamplingForbiddenModel is false for fable-5-21', () => {
    expect(isNonDefaultSamplingForbiddenModel('fable-5-21')).toBe(false);
  });
});

// ── Temperature-drop warning ──────────────────────────────────────────────

describe('Fable 5.2 temperature-drop warning', () => {
  beforeEach(() => {
    _resetWarnedTemperatureClampsForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a console.warn when temperature is dropped for a Fable 5.2 model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAnthropicTemperature(0.7, ID);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('temperature=0.7');
    expect(msg).toContain(ID);
    expect(msg).toContain('non-default sampling forbidden');
  });

  it('deduplicates: a second call with the same model does NOT warn again', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAnthropicTemperature(0.5, ID);
    resolveAnthropicTemperature(0.9, ID);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does NOT warn for non-Fable models', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAnthropicTemperature(0.5, 'claude-sonnet-4-6');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
