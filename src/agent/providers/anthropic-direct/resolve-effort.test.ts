/**
 * Unit tests for the `anthropic-direct` provider's budget/effort resolvers:
 * `resolveEffort`, `resolveThinkingParam`, and `resolveMaxTokens`.
 *
 * `resolveEffort` auto-defaults to `'max'` on the production-verified
 * allowlist (`opus-4-6`, `opus-4-7`, `opus-4-8`, `sonnet-4-6`, `sonnet-4-7`)
 * and passes explicit values through unchanged for all models. Older 4-x
 * variants and Haiku return HTTP 400 when `output_config.effort` is set, so
 * the auto-default is gated to known-good ids; explicit overrides still flow
 * through unchanged to fail loudly rather than silently ignore.
 *
 * `resolveMaxTokens` clamps the requested output cap to the model ceiling;
 * `resolveThinkingParam` reserves output room so an enabled thinking budget
 * cannot starve the visible reply.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffort, resolveMaxTokens, resolveThinkingParam } from './resolve-params.js';
import { maxOutputTokensFor } from '../../model-limits.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ThinkingConfig } from '../../types/sdk-types.js';

describe('resolveEffort', () => {
  // ── Auto-default to "max" on the allowlist ─────────────────────────────

  it('defaults to "max" for claude-opus-4-8 (any suffix)', () => {
    // Lock in: on opus-4-8 the server's default effort flipped to `high`.
    // We override with `max` to preserve the high-thinking-depth experience
    // users had on 4.7. See the resolveEffort docstring rule 2.
    expect(resolveEffort(undefined, 'claude-opus-4-8')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-8-20260528')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-8-latest')).toBe('max');
  });

  it('defaults to "max" for claude-opus-4-7 (any suffix)', () => {
    expect(resolveEffort(undefined, 'claude-opus-4-7-20250901')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-7-latest')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-7')).toBe('max');
  });

  it('defaults to "max" for claude-opus-4-6 (any suffix)', () => {
    expect(resolveEffort(undefined, 'claude-opus-4-6')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-6-20250901')).toBe('max');
  });

  it('defaults to "max" for claude-sonnet-4-6 and 4-7', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-4-6')).toBe('max');
    expect(resolveEffort(undefined, 'claude-sonnet-4-6-20250901')).toBe('max');
    expect(resolveEffort(undefined, 'claude-sonnet-4-7-latest')).toBe('max');
  });

  it('defaults to "max" for claude-sonnet-5 (adaptive-thinking Sonnet tier)', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-5')).toBe('max');
    expect(resolveEffort(undefined, 'claude-sonnet-5-20260630')).toBe('max');
  });

  // ── Explicit caller overrides always win ───────────────────────────────

  it('returns the explicit effort when caller specifies it, even on opus-4-7', () => {
    expect(resolveEffort('low', 'claude-opus-4-7-20250901')).toBe('low');
    expect(resolveEffort('medium', 'claude-opus-4-7-20250901')).toBe('medium');
    expect(resolveEffort('high', 'claude-opus-4-7-20250901')).toBe('high');
    expect(resolveEffort('max', 'claude-opus-4-7-20250901')).toBe('max');
  });

  it('passes explicit effort through on models that would otherwise omit it', () => {
    // Caller's explicit value flows through even where auto-default would
    // skip the field — so the API can return its own 400 if the model
    // genuinely does not support effort, rather than us silently dropping
    // the override.
    expect(resolveEffort('high', 'claude-sonnet-4-5-20250929')).toBe('high');
    expect(resolveEffort('low', 'claude-haiku-4-5-20250929')).toBe('low');
    expect(resolveEffort('max', 'claude-opus-4-1-20250805')).toBe('max');
  });

  // ── Models off the allowlist: no auto-default ─────────────────────────

  it('returns undefined for older 4-x variants (which reject effort with HTTP 400)', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-4-5-20250929')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-sonnet-4-5')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-opus-4-1-20250805')).toBeUndefined();
  });

  it('returns undefined for every Haiku (Haiku rejects effort)', () => {
    expect(resolveEffort(undefined, 'claude-haiku-4-5-20251001')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-haiku-4-5')).toBeUndefined();
  });

  it('returns undefined for 3.x and unknown ids', () => {
    expect(resolveEffort(undefined, 'claude-3-5-sonnet-20241022')).toBeUndefined();
    expect(resolveEffort(undefined, 'some-mystery-model')).toBeUndefined();
  });
});

describe('resolveMaxTokens', () => {
  const cfg = (maxOutputTokens?: number): AgentConfig =>
    ({ maxOutputTokens } as unknown as AgentConfig);
  const model = 'claude-sonnet-4-6';
  const ceiling = maxOutputTokensFor(model);

  it('falls back to the model ceiling when maxOutputTokens is unset', () => {
    expect(resolveMaxTokens(cfg(undefined), model)).toBe(ceiling);
  });

  it('uses a finite positive value that fits under the ceiling', () => {
    const fits = Math.floor(ceiling / 2);
    expect(resolveMaxTokens(cfg(fits), model)).toBe(fits);
  });

  it('clamps a value that exceeds the model ceiling', () => {
    expect(resolveMaxTokens(cfg(ceiling + 500_000), model)).toBe(ceiling);
  });

  it('treats the POSITIVE_INFINITY "max" sentinel as the model ceiling', () => {
    expect(resolveMaxTokens(cfg(Number.POSITIVE_INFINITY), model)).toBe(ceiling);
  });

  it('falls back to the ceiling for zero, negative, or NaN values', () => {
    expect(resolveMaxTokens(cfg(0), model)).toBe(ceiling);
    expect(resolveMaxTokens(cfg(-5), model)).toBe(ceiling);
    expect(resolveMaxTokens(cfg(Number.NaN), model)).toBe(ceiling);
  });

  it('floors a fractional value that fits', () => {
    const fits = Math.floor(ceiling / 2) + 0.9;
    expect(resolveMaxTokens(cfg(fits), model)).toBe(Math.floor(fits));
  });
});

describe('resolveThinkingParam', () => {
  const enabled = (budgetTokens?: number): ThinkingConfig =>
    budgetTokens === undefined
      ? { type: 'enabled' }
      : { type: 'enabled', budgetTokens };
  // 64_000 max → reserve 25% (16_000) → thinking cap = 64_000 - 1 - 16_000.
  const RESERVE_MODEL = 'claude-sonnet-4-6';

  it('reserves output room when thinking is enabled without an explicit budget', () => {
    const p = resolveThinkingParam(enabled(), 64_000, RESERVE_MODEL) as {
      type: string;
      budget_tokens?: number;
    };
    expect(p.type).toBe('enabled');
    expect(p.budget_tokens).toBe(47_999);
    expect(64_000 - (p.budget_tokens ?? 0)).toBeGreaterThanOrEqual(16_000);
  });

  it('clamps an oversized explicit budget to leave output room', () => {
    const p = resolveThinkingParam(enabled(60_000), 64_000, RESERVE_MODEL) as {
      budget_tokens?: number;
    };
    expect(p.budget_tokens).toBe(47_999);
  });

  it('honours an explicit budget that already leaves room', () => {
    const p = resolveThinkingParam(enabled(2_000), 64_000, RESERVE_MODEL) as {
      budget_tokens?: number;
    };
    expect(p.budget_tokens).toBe(2_000);
  });

  it('keeps the API minimum of 1024 for tiny explicit budgets', () => {
    const p = resolveThinkingParam(enabled(100), 64_000, RESERVE_MODEL) as {
      budget_tokens?: number;
    };
    expect(p.budget_tokens).toBe(1_024);
  });

  it('always keeps 1024 <= budget_tokens < max_tokens across budget sizes', () => {
    for (const max of [2_000, 10_000, 64_000, 128_000]) {
      const p = resolveThinkingParam(enabled(), max, RESERVE_MODEL) as {
        budget_tokens?: number;
      };
      expect(p.budget_tokens ?? 0).toBeLessThan(max);
      expect(p.budget_tokens ?? 0).toBeGreaterThanOrEqual(1_024);
    }
  });

  it('promotes enabled to adaptive on opus-4.7+ (no explicit budget leaks through)', () => {
    const p = resolveThinkingParam(enabled(60_000), 64_000, 'claude-opus-4-8') as {
      type: string;
      budget_tokens?: number;
    };
    expect(p.type).toBe('adaptive');
    expect(p.budget_tokens).toBeUndefined();
  });

  it('promotes enabled to adaptive on claude-sonnet-5 (adaptive-only; no budget leaks through)', () => {
    const p = resolveThinkingParam(enabled(60_000), 64_000, 'claude-sonnet-5') as {
      type: string;
      budget_tokens?: number;
    };
    expect(p.type).toBe('adaptive');
    expect(p.budget_tokens).toBeUndefined();
  });

  it('passes adaptive and disabled through unchanged', () => {
    expect(resolveThinkingParam({ type: 'adaptive' }, 64_000)).toMatchObject({
      type: 'adaptive',
    });
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000)).toEqual({ type: 'disabled' });
  });
});
