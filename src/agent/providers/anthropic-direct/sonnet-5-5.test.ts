/**
 * Claude Sonnet 5.5 (released 2026-09-28) onboarding contract.
 *
 * Every table in the harness is keyed by exact model id, and the effort /
 * thinking regexes are unanchored — `(opus|sonnet)-5` substring-matches
 * `sonnet-5-5`. These tests pin the Sonnet 5.5 entries so a refactor of the
 * shared Sonnet 5 regexes cannot silently change its behaviour.
 *
 * Sources (verified 2026-09-28):
 *  - https://platform.claude.com/docs/en/about-claude/models/overview
 *    (1M context, 128K output, default effort high, adaptive thinking)
 *  - https://platform.claude.com/docs/en/about-claude/pricing
 *  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
 *    (`disabled` → 400; `between_tools` replaces it at low/medium/high only)
 */

import { describe, it, expect } from 'vitest';
import { resolveEffort, resolveThinkingParam } from './resolve-params.js';
import { deriveCallCostUsd } from './pricing.js';
import { starterModels } from './query-options.js';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';

const ID = 'claude-sonnet-5-5';
const M = 1_000_000;

describe('Claude Sonnet 5.5 limits', () => {
  it('reports the native 1M window and 128K output (not the 200k / 64k fallbacks)', () => {
    expect(contextLimitFor(ID)).toBe(1_000_000);
    expect(maxOutputTokensFor(ID)).toBe(128_000);
  });

  it('keeps the same 200k auto-compact working budget as Sonnet 5', () => {
    expect(autoCompactLimitFor(ID)).toBe(autoCompactLimitFor('claude-sonnet-5'));
    expect(autoCompactLimitFor(ID)).toBe(200_000);
  });
});

describe('Claude Sonnet 5.5 pricing', () => {
  it('prices at $2 input / $10 output / $0.20 cache read per MTok', () => {
    expect(deriveCallCostUsd(ID, M, 0, 0, 0)).toBeCloseTo(2.0, 8);
    expect(deriveCallCostUsd(ID, 0, M, 0, 0)).toBeCloseTo(10.0, 8);
    expect(deriveCallCostUsd(ID, 0, 0, M, 0)).toBeCloseTo(0.2, 8);
  });

  it('prices 5-minute cache writes at $2.50 per MTok', () => {
    expect(deriveCallCostUsd(ID, 0, 0, 0, M)).toBeCloseTo(2.5, 8);
  });
});

describe('Claude Sonnet 5.5 effort default', () => {
  it('defaults to "high", not the "max" the Sonnet 5 substring regex would give', () => {
    expect(resolveEffort(undefined, ID)).toBe('high');
    expect(resolveEffort(undefined, `${ID}-20260928`)).toBe('high');
  });

  it('leaves Sonnet 5 on "max" (carve-out does not leak to the sibling)', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-5')).toBe('max');
  });

  it('passes explicit effort through unchanged', () => {
    expect(resolveEffort('max', ID)).toBe('max');
    expect(resolveEffort('low', ID)).toBe('low');
  });
});

describe('Claude Sonnet 5.5 thinking', () => {
  it('promotes enabled to adaptive (enabled + budget_tokens is a 400)', () => {
    const p = resolveThinkingParam({ type: 'enabled' }, 64_000, ID) as { type: string; budget_tokens?: number };
    expect(p.type).toBe('adaptive');
    expect(p.budget_tokens).toBeUndefined();
  });

  it.each(['low', 'medium', 'high', undefined])(
    'translates disabled to bare between_tools at effort %s',
    (effort) => {
      expect(resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toEqual({
        type: 'between_tools',
      });
    },
  );

  it.each(['xhigh', 'max'])('throws a legible error for disabled at effort %s', (effort) => {
    expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toThrow(
      /claude-sonnet-5-5.*thinking off.*low\/medium\/high/,
    );
  });

  it('still passes disabled through unchanged on Sonnet 5', () => {
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-sonnet-5')).toEqual({
      type: 'disabled',
    });
  });
});

describe('Claude Sonnet 5.5 model picker', () => {
  it('is listed in the starter models', () => {
    expect(starterModels().map((m) => m.value)).toContain(ID);
  });
});
