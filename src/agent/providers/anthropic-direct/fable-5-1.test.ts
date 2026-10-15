/**
 * Claude Fable 5.1 (successor to Fable 5) onboarding contract.
 *
 * Breaking constraints (per https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1):
 *   1. Adaptive thinking is always on — `{type:'enabled'}` and `{type:'disabled'}` → 400.
 *   2. Non-default temperature/top_p/top_k → 400 (same as Fable 5).
 *   3. Forced tool use (`tool_choice: any/tool`) → 400 (AFK never sends this).
 *   4. Thinking blocks are prefix-bound — editing prior turns invalidates them.
 *      AFK opts into `drop_block` via `thinking-binding-controls-2026-08-01` beta.
 *
 * Wire IDs under test:
 *   - `claude-fable-5-1`  (GA, all customers)
 *
 * These tests ensure that every table in the harness is correctly keyed and that
 * the fable-5-1 predicates in resolve-params.ts do not silently break when Fable 5
 * or other model regex branches are refactored.
 *
 * Sources (verified 2026-10-03):
 *  - https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
 *  - https://platform.claude.com/docs/en/about-claude/pricing
 *  - https://platform.claude.com/docs/en/build-with-claude/context-windows
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isFable51,
  resolveEffort,
  resolveThinkingParam,
  resolveAnthropicTemperature,
  isNonDefaultSamplingForbiddenModel,
  _resetWarnedTemperatureClampsForTest,
} from './resolve-params.js';
import { deriveCallCostUsd } from './pricing.js';
import { starterModels } from './query-options.js';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';
import { CLAUDE_FABLE_5_1_ID, DIRECT_MODEL_ALIASES } from '../../session/model-slots.js';

const ID = 'claude-fable-5-1';
const M = 1_000_000;

// ── Model-ID constant and alias wiring ────────────────────────────────────

describe('Fable 5.1 model-slot constant', () => {
  it('CLAUDE_FABLE_5_1_ID is the expected wire id', () => {
    expect(CLAUDE_FABLE_5_1_ID).toBe(ID);
  });

  it('DIRECT_MODEL_ALIASES fable → claude-fable-5-1', () => {
    expect(DIRECT_MODEL_ALIASES['fable']).toBe(ID);
  });

  it('DIRECT_MODEL_ALIASES does NOT include a fable-5-1 key (raw id passes through)', () => {
    // Raw wire id takes the passthrough branch; only the `fable` short alias
    // is in DIRECT_MODEL_ALIASES.
    expect(DIRECT_MODEL_ALIASES[ID]).toBeUndefined();
  });
});

// ── Context window and output limits ──────────────────────────────────────

describe('Fable 5.1 limits', () => {
  it('reports the native 1M context window and 128K output cap', () => {
    expect(contextLimitFor(ID)).toBe(1_000_000);
    expect(maxOutputTokensFor(ID)).toBe(128_000);
  });

  it('uses the full 1M window for auto-compaction (no reduced working budget)', () => {
    // Fable is the premium long-horizon model; the user chose it for its 1M
    // window. Unlike base `sonnet`/`opus` aliases (which compact at 200k to
    // save cost), Fable 5.1 should never compact early by default.
    expect(autoCompactLimitFor(ID)).toBe(1_000_000);
  });

  it('fable alias also reports 1M context and 128K output', () => {
    expect(contextLimitFor('fable')).toBe(1_000_000);
    expect(maxOutputTokensFor('fable')).toBe(128_000);
  });
});

// ── Pricing: same as Fable 5, except cache reads at $0.25/MTok ───────────

describe('Fable 5.1 pricing', () => {
  it('prices at $10 input / $50 output per MTok (same as Fable 5)', () => {
    expect(deriveCallCostUsd(ID, M, 0, 0, 0)).toBeCloseTo(10.0, 8);
    expect(deriveCallCostUsd(ID, 0, M, 0, 0)).toBeCloseTo(50.0, 8);
  });

  it('prices cache reads at $0.25/MTok (0.025x base, quarter of Fable 5 rate)', () => {
    // Fable 5 cache reads: $1.00/MTok. Fable 5.1: $0.25/MTok.
    expect(deriveCallCostUsd(ID, 0, 0, M, 0)).toBeCloseTo(0.25, 8);
  });

  it('prices Fable 5 cache reads at $1.00/MTok (preserved for back-compat)', () => {
    expect(deriveCallCostUsd('claude-fable-5', 0, 0, M, 0)).toBeCloseTo(1.00, 8);
  });

  it('prices 5-minute cache writes at $12.50/MTok (same as Fable 5)', () => {
    expect(deriveCallCostUsd(ID, 0, 0, 0, M)).toBeCloseTo(12.5, 8);
  });

  it('prices 1-hour cache writes at $20/MTok (same as Fable 5)', () => {
    expect(
      deriveCallCostUsd(ID, 0, 0, 0, M, { ephemeral5m: 0, ephemeral1h: M }),
    ).toBeCloseTo(20.0, 8);
  });
});

// ── Effort default ────────────────────────────────────────────────────────

describe('Fable 5.1 effort default', () => {
  it('defaults to "high" (not the "max" the shared regex gives Sonnet 5 / Opus 5)', () => {
    expect(resolveEffort(undefined, ID)).toBe('high');
    expect(resolveEffort(undefined, `${ID}-20261001`)).toBe('high');
  });

  it('passes explicit effort through unchanged', () => {
    expect(resolveEffort('max', ID)).toBe('max');
    expect(resolveEffort('low', ID)).toBe('low');
    expect(resolveEffort('medium', ID)).toBe('medium');
  });

  it('does not affect Fable 5 (which gets the fallback default, not "high")', () => {
    // Fable 5 is not on the auto-default allowlist; callers can override.
    expect(resolveEffort(undefined, 'claude-fable-5')).toBeUndefined();
  });
});

// ── Thinking: always adaptive — enabled and disabled → 400 ───────────────

describe('Fable 5.1 thinking constraints', () => {
  it('promotes enabled to adaptive (API rejects {type:"enabled"} with HTTP 400)', () => {
    const result = resolveThinkingParam({ type: 'enabled' }, 64_000, ID) as {
      type: string;
      budget_tokens?: number;
    };
    expect(result.type).toBe('adaptive');
    // No budget_tokens on adaptive — the model controls thinking depth via effort.
    expect(result.budget_tokens).toBeUndefined();
  });

  it('throws a legible error for disabled (API rejects {type:"disabled"} at every effort)', () => {
    expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID)).toThrow(
      /fable-5-1.*adaptive thinking.*cannot be disabled/,
    );
  });

  it('throws the same error for disabled regardless of effort level', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toThrow(
        /fable-5-1/,
      );
    }
  });

  it('passes adaptive through unchanged (the correct explicit choice)', () => {
    const result = resolveThinkingParam({ type: 'adaptive' }, 64_000, ID);
    expect(result).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('does NOT affect Fable 5 (which supports {type:"enabled"} extended thinking)', () => {
    // Fable 5 is NOT adaptive-only; it should still produce an enabled result.
    const result = resolveThinkingParam({ type: 'enabled' }, 64_000, 'claude-fable-5') as {
      type: string;
      budget_tokens?: number;
    };
    expect(result.type).toBe('enabled');
    expect(result.budget_tokens).toBeGreaterThan(0);
  });
});

// ── Non-default sampling forbidden ───────────────────────────────────────

describe('Fable 5.1 non-default sampling', () => {
  it('isNonDefaultSamplingForbiddenModel returns true for claude-fable-5-1', () => {
    expect(isNonDefaultSamplingForbiddenModel(ID)).toBe(true);
    expect(isNonDefaultSamplingForbiddenModel(`${ID}-20261001`)).toBe(true);
  });

  it('resolveAnthropicTemperature returns undefined for fable-5-1 (drops any value)', () => {
    // The API rejects non-default temperature with HTTP 400.
    expect(resolveAnthropicTemperature(0.5, ID)).toBeUndefined();
    expect(resolveAnthropicTemperature(1.0, ID)).toBeUndefined();
    expect(resolveAnthropicTemperature(0.0, ID)).toBeUndefined();
  });

  it('isNonDefaultSamplingForbiddenModel returns false for Fable 5', () => {
    // Fable 5 accepts non-default sampling; the guard must not bleed to it.
    expect(isNonDefaultSamplingForbiddenModel('claude-fable-5')).toBe(false);
  });

  it('isNonDefaultSamplingForbiddenModel returns false for Opus 5', () => {
    expect(isNonDefaultSamplingForbiddenModel('claude-opus-5')).toBe(false);
  });
});

// ── Model picker presence ─────────────────────────────────────────────────

describe('Fable 5.1 model picker', () => {
  it('is listed in the starter models', () => {
    expect(starterModels().map((m) => m.value)).toContain(ID);
  });

  it('Fable 5 wire id is NOT in the starter models (superseded by 5.1)', () => {
    // Fable 5 stays reachable by raw wire id at the /model surface, but is no
    // longer promoted in the picker now that Fable 5.1 is the stable target.
    expect(starterModels().map((m) => m.value)).not.toContain('claude-fable-5');
  });
});

// ── isFable51 regex boundary (Finding 1) ──────────────────────────────────
// The regex must NOT match fable-5-10, fable-5-11, or any hypothetical
// fable-5-1x suffix — only fable-5-1 terminated by a non-identifier character
// or end-of-string.

describe('isFable51 regex boundary', () => {
  // Must MATCH
  it('matches claude-fable-5-1 (canonical wire id)', () => {
    expect(isFable51('claude-fable-5-1')).toBe(true);
  });

  it('matches fable-5-1 (without claude- prefix)', () => {
    expect(isFable51('fable-5-1')).toBe(true);
  });

  it('matches claude-fable-5-1-20261001 (dated release)', () => {
    expect(isFable51('claude-fable-5-1-20261001')).toBe(true);
  });

  it('matches claude-fable-5-1@beta (at-sign separator)', () => {
    expect(isFable51('claude-fable-5-1@beta')).toBe(true);
  });

  it('matches claude-fable-5-1.0 (dot separator)', () => {
    expect(isFable51('claude-fable-5-1.0')).toBe(true);
  });

  // Must NOT MATCH — the anchored boundary prevents these
  it('does NOT match claude-fable-5-10', () => {
    expect(isFable51('claude-fable-5-10')).toBe(false);
  });

  it('does NOT match fable-5-11', () => {
    expect(isFable51('fable-5-11')).toBe(false);
  });

  it('does NOT match claude-fable-5-1x', () => {
    expect(isFable51('claude-fable-5-1x')).toBe(false);
  });

  // Confirm guard also holds through isNonDefaultSamplingForbiddenModel (which
  // calls isFable51 internally).
  it('isNonDefaultSamplingForbiddenModel is false for fable-5-10', () => {
    expect(isNonDefaultSamplingForbiddenModel('claude-fable-5-10')).toBe(false);
  });

  it('isNonDefaultSamplingForbiddenModel is false for fable-5-11', () => {
    expect(isNonDefaultSamplingForbiddenModel('fable-5-11')).toBe(false);
  });
});

// ── Finding 4: silent temperature-drop warning ────────────────────────────

describe('Fable 5.1 temperature-drop warning', () => {
  beforeEach(() => {
    // Reset the module-level dedup Set so each test starts clean.
    _resetWarnedTemperatureClampsForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a console.warn when temperature is dropped for a Fable 5.1 model', () => {
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
    // Two calls for the same model — only one warn expected (Set dedup).
    resolveAnthropicTemperature(0.5, ID);
    resolveAnthropicTemperature(0.9, ID);
    // The Set key is keyed on model, not on temperature value, so both calls
    // share the same dedup key and only one warn fires.
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does NOT warn for non-Fable models', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAnthropicTemperature(0.5, 'claude-sonnet-4-6');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
