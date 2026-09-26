/**
 * Unit tests for the `anthropic-direct` provider's budget/effort resolvers:
 * `resolveEffort`, `resolveThinkingParam`, and `resolveMaxTokens`.
 *
 * `resolveEffort` auto-defaults to `'max'` on the production-verified
 * allowlist (`opus-4-6`, `opus-4-7`, `opus-4-8`, `opus-5`, `sonnet-4-6`,
 * `sonnet-4-7`, `sonnet-5`) and to `'high'` for `opus-5-5` (whose server
 * default is `medium`, lower than the `high` default on all other models),
 * and passes explicit values through unchanged for all models. Older 4-x
 * variants and Haiku return HTTP 400 when `output_config.effort` is set, so
 * the auto-default is gated to known-good ids; explicit overrides still flow
 * through unchanged to fail loudly rather than silently ignore.
 *
 * `resolveMaxTokens` clamps the requested output cap to the model ceiling;
 * `resolveThinkingParam` reserves output room so an enabled thinking budget
 * cannot starve the visible reply.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveEffort, resolveMaxTokens, resolveThinkingParam, resolveAnthropicTemperature, resumeHistoryToMessages, filterContentBlocks, hasValidToolUsePairing } from './resolve-params.js';
import { maxOutputTokensFor } from '../../model-limits.js';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import type { ThinkingConfig } from '../../types/sdk-types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

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

  it('defaults to "max" for claude-opus-5 (adaptive-thinking Opus tier)', () => {
    // Opus 5's server-side default effort is `high`; we override to `max` for
    // thinking depth, same as the rest of the allowlist. Guards the regex that
    // was widened from `sonnet-5` to `(opus|sonnet)-(4-[678]|5)` — a refactor
    // there must not silently drop the new default model off the allowlist.
    expect(resolveEffort(undefined, 'claude-opus-5')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-5-20260724')).toBe('max');
  });

  it('defaults to "high" for claude-opus-5-5 (server default is medium; high for agentic depth)', () => {
    // Opus 5.5's server-side default effort is `medium` (the only model with a
    // non-`high` default). We raise to `high` for agentic coding depth without
    // the excessive thinking-token accumulation that `max` causes. The opus-5-5
    // check must fire BEFORE the general `(opus|sonnet)-(4-[678]|5)` regex,
    // which matches `opus-5` as a substring of `opus-5-5` and would return `max`.
    expect(resolveEffort(undefined, 'claude-opus-5-5')).toBe('high');
    expect(resolveEffort(undefined, 'claude-opus-5-5-20260922')).toBe('high');
  });

  it('allows explicit effort override on opus-5-5', () => {
    expect(resolveEffort('max', 'claude-opus-5-5')).toBe('max');
    expect(resolveEffort('medium', 'claude-opus-5-5')).toBe('medium');
    expect(resolveEffort('low', 'claude-opus-5-5')).toBe('low');
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

describe('resolveAnthropicTemperature', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes through undefined (server default)', () => {
    expect(resolveAnthropicTemperature(undefined)).toBeUndefined();
  });

  it('passes through values within the Anthropic range (0-1)', () => {
    expect(resolveAnthropicTemperature(0)).toBe(0);
    expect(resolveAnthropicTemperature(0.5)).toBe(0.5);
    expect(resolveAnthropicTemperature(1.0)).toBe(1.0);
  });

  it('clamps values above the Anthropic maximum (1.0) with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveAnthropicTemperature(1.5)).toBe(1.0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temperature 1.5'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamping to 1'));
  });

  it('clamps 2.0 (OpenAI max) down to 1.0', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveAnthropicTemperature(2.0)).toBe(1.0);
  });

  it('returns undefined for negative values', () => {
    expect(resolveAnthropicTemperature(-1)).toBeUndefined();
  });

  it('returns undefined for NaN', () => {
    expect(resolveAnthropicTemperature(Number.NaN)).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(resolveAnthropicTemperature(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('warns only once per distinct value (dedupe)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAnthropicTemperature(1.8);
    resolveAnthropicTemperature(1.8);
    // Dedupe key is temp:<value>, so the second call should not warn again.
    // Note: since the dedupe set persists across tests, the first call may or
    // may not warn depending on test ordering — we check at most 1.
    const calls = warn.mock.calls.filter(c => String(c[0]).includes('1.8'));
    expect(calls.length).toBeLessThanOrEqual(1);
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

  // #951: max_tokens <= 1024 leaves no valid budget (the API needs
  // 1024 <= budget < max_tokens, an empty interval here). Fail fast with a
  // legible error instead of emitting budget == max_tokens and 400ing every turn.
  it('throws for max_tokens <= 1024 on an enabled (non-adaptive) model', () => {
    for (const max of [1_024, 512, 100, 1]) {
      expect(() => resolveThinkingParam(enabled(), max, RESERVE_MODEL), `max=${max}`).toThrow(
        /Extended thinking requires max_tokens > 1024/,
      );
    }
  });

  it('does NOT throw at max_tokens = 1025 (smallest satisfiable) and keeps budget < max_tokens', () => {
    const p = resolveThinkingParam(enabled(), 1_025, RESERVE_MODEL) as {
      budget_tokens?: number;
    };
    expect(p.budget_tokens).toBe(1_024);
    expect(p.budget_tokens ?? 0).toBeLessThan(1_025);
  });

  it('does NOT throw for a tiny max_tokens on adaptive-promoted models (guard runs after promotion)', () => {
    // opus-5 / sonnet-5 promote enabled → adaptive before the budget math, so a
    // tiny cap never reaches the #951 guard — no throw, no budget leak.
    for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5']) {
      const p = resolveThinkingParam(enabled(), 512, m) as { type: string; budget_tokens?: number };
      expect(p.type, m).toBe('adaptive');
      expect(p.budget_tokens, m).toBeUndefined();
    }
  });

  it('never throws for adaptive regardless of max_tokens', () => {
    expect(() => resolveThinkingParam({ type: 'adaptive' }, 100, RESERVE_MODEL)).not.toThrow();
  });

  it('never throws for disabled on a non-adaptive model (e.g. claude-sonnet-4-6)', () => {
    expect(() => resolveThinkingParam({ type: 'disabled' }, 100, RESERVE_MODEL)).not.toThrow();
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, RESERVE_MODEL)).toEqual({
      type: 'disabled',
    });
  });

  // ── #2073: disabled thinking on adaptive-only models ──────────────────

  it('throws a clear agent-afk error for disabled on claude-opus-5-5 (always adaptive-only)', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5-5'),
    ).toThrow(/claude-opus-5-5.*cannot be disabled|cannot be disabled.*claude-opus-5-5/i);
  });

  it('throws for disabled on claude-opus-5-5 with a dated model id', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5-5-20260922'),
    ).toThrow(/cannot be disabled/);
  });

  // Rejecting `enabled` (requiresAdaptiveThinking) does not imply rejecting
  // `disabled`: these models accept it, so it must pass through unchanged.
  it('passes disabled through on claude-sonnet-5 (rejects enabled, accepts disabled)', () => {
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-sonnet-5')).toEqual({
      type: 'disabled',
    });
  });

  it.each(['claude-opus-4-7', 'claude-opus-4-8'])('passes disabled through on %s', (model) => {
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, model)).toEqual({ type: 'disabled' });
  });

  it('throws for disabled on claude-opus-5 at max effort (#2073 Opus-5 case)', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'max'),
    ).toThrow(/claude-opus-5.*disabled.*max|disabled.*max.*claude-opus-5/i);
  });

  it('throws for disabled on claude-opus-5 at xhigh effort', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'xhigh'),
    ).toThrow(/effort/);
  });

  it('does NOT throw for disabled on claude-opus-5 at high effort (allowed)', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'high'),
    ).not.toThrow();
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'high')).toEqual({
      type: 'disabled',
    });
  });

  it('does NOT throw for disabled on claude-opus-5 with no effort supplied', () => {
    // When effort is undefined (not resolved), we cannot know it's forbidden — pass through.
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5'),
    ).not.toThrow();
  });

  it('does NOT throw for disabled on claude-opus-5 at low/medium effort', () => {
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'low'),
    ).not.toThrow();
    expect(() =>
      resolveThinkingParam({ type: 'disabled' }, 64_000, 'claude-opus-5', 'medium'),
    ).not.toThrow();
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

  it('promotes enabled to adaptive on claude-opus-5 (adaptive-only; no budget leaks through)', () => {
    // Opus 5's model card is "Extended thinking: No / Adaptive thinking: Yes",
    // so a manual {type:'enabled'} must never reach the wire — the API rejects
    // it. Guards requiresAdaptiveThinking's widened `(opus|sonnet)-5` branch.
    const p = resolveThinkingParam(enabled(60_000), 64_000, 'claude-opus-5') as {
      type: string;
      budget_tokens?: number;
    };
    expect(p.type).toBe('adaptive');
    expect(p.budget_tokens).toBeUndefined();
  });

  it('promotes enabled to adaptive on claude-opus-5-5 (adaptive-only, always on)', () => {
    // Opus 5.5's adaptive thinking is always on and cannot be disabled.
    // {type:'enabled'} must promote to adaptive (same as opus-5).
    const p = resolveThinkingParam(enabled(60_000), 64_000, 'claude-opus-5-5') as {
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

describe('filterContentBlocks (#2003 — runtime type validation)', () => {
  // ── Allowlisted types pass through ──────────────────────────────────────

  it('passes through all valid ContentBlockParam types', () => {
    const validBlocks: unknown[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'abc' } },
      { type: 'search_result', source: { type: 'url', url: 'https://example.com' }, title: 'Example', content: [] },
      { type: 'thinking', thinking: 'my reasoning', signature: 'sig123' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt\n' },
      { type: 'server_tool_use', id: 'stu_1', name: 'web_search', input: { query: 'foo' } },
      { type: 'web_search_tool_result', tool_use_id: 'stu_1', content: [] },
    ];
    const result = filterContentBlocks(validBlocks);
    expect(result).toHaveLength(validBlocks.length);
    // Verify each block came through as-is (same reference)
    for (let i = 0; i < validBlocks.length; i++) {
      expect(result[i]).toBe(validBlocks[i]);
    }
  });

  // ── Unknown / crafted types are rejected ──────────────────────────────

  it('drops blocks with unknown type values', () => {
    const mixed: unknown[] = [
      { type: 'text', text: 'keep me' },
      { type: 'injected_malicious_type', payload: 'evil' },
      { type: 'custom_block', data: 'attacker-controlled' },
      { type: 'text', text: 'also keep me' },
    ];
    const result = filterContentBlocks(mixed);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'keep me' });
    expect(result[1]).toEqual({ type: 'text', text: 'also keep me' });
  });

  it('drops blocks where the type field is an empty string', () => {
    const blocks: unknown[] = [
      { type: '', text: 'no type' },
      { type: 'text', text: 'valid' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'valid' });
  });

  // ── Missing or non-string type field ─────────────────────────────────

  it('drops blocks with no type field', () => {
    const blocks: unknown[] = [
      { text: 'orphan text, no type' },
      { type: 'text', text: 'valid' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
  });

  it('drops blocks where type is not a string (number, boolean, null, object)', () => {
    const blocks: unknown[] = [
      { type: 42, text: 'numeric type' },
      { type: true, text: 'boolean type' },
      { type: null, text: 'null type' },
      { type: { nested: 'object' }, text: 'object type' },
      { type: 'text', text: 'the only valid one' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'the only valid one' });
  });

  // ── Non-object entries ────────────────────────────────────────────────

  it('drops null entries', () => {
    const blocks: unknown[] = [null, { type: 'text', text: 'valid' }, null];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
  });

  it('drops primitive entries (string, number, boolean)', () => {
    const blocks: unknown[] = [
      'raw string',
      42,
      true,
      { type: 'text', text: 'valid' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
  });

  it('drops nested array entries (arrays are not valid blocks)', () => {
    const blocks: unknown[] = [
      ['type', 'text'],
      { type: 'text', text: 'valid' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('returns an empty array for undefined input', () => {
    expect(filterContentBlocks(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty input array', () => {
    expect(filterContentBlocks([])).toEqual([]);
  });

  it('returns an empty array when all blocks are invalid', () => {
    const blocks: unknown[] = [
      null,
      'string',
      { type: 'unknown_type', payload: 'x' },
      { text: 'no type field' },
    ];
    expect(filterContentBlocks(blocks)).toEqual([]);
  });

  it('handles a mix of valid and every invalid shape in one array', () => {
    // This is the realistic "corrupted sidecar" scenario — the attacker
    // interleaves crafted blocks with legitimate ones. Only valid blocks should
    // survive.
    const blocks: unknown[] = [
      { type: 'thinking', thinking: 'safe', signature: 's1' },
      null,
      { type: 'text', text: 'safe text' },
      { type: 'INJECTION', name: 'bash', input: {} },        // attacker tool_use lookalike
      { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: '/etc/passwd' } },
      42,
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'root:...' },
      { payload: 'no type' },
    ];
    const result = filterContentBlocks(blocks);
    expect(result).toHaveLength(4);
    expect((result[0] as { type: string }).type).toBe('thinking');
    expect((result[1] as { type: string }).type).toBe('text');
    expect((result[2] as { type: string }).type).toBe('tool_use');
    expect((result[3] as { type: string }).type).toBe('tool_result');
  });
});

describe('resumeHistoryToMessages', () => {
  // ── Backward-compat: text-only path (pre-v5.226 sidecars) ─────────────

  it('returns undefined for undefined or empty history', () => {
    expect(resumeHistoryToMessages(undefined)).toBeUndefined();
    expect(resumeHistoryToMessages([])).toBeUndefined();
  });

  it('produces alternating user/assistant text messages from old-sidecar turns (no contentBlocks)', () => {
    const history: ResumeHistoryTurn[] = [
      { user: 'q1', assistant: 'a1' },
      { user: 'q2', assistant: 'a2' },
    ];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('skips empty user/assistant strings in text-only turns', () => {
    const history: ResumeHistoryTurn[] = [{ user: 'q', assistant: '' }];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('returns undefined when all turns have empty text and no content blocks', () => {
    const history: ResumeHistoryTurn[] = [{ user: '', assistant: '' }];
    expect(resumeHistoryToMessages(history)).toBeUndefined();
  });

  // ── Structured path: content blocks present (v5.226+ sidecars) ────────

  it('uses assistantContentBlocks directly when present, preserving tool_use and thinking blocks', () => {
    const assistantBlocks: ContentBlockParam[] = [
      { type: 'thinking', thinking: 'my reasoning', signature: 'sig' },
      { type: 'text', text: 'Here is the answer.' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
    ];
    const userBlocks: ContentBlockParam[] = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt\n' },
    ];
    const history: ResumeHistoryTurn[] = [
      {
        user: 'fallback user text',
        assistant: 'fallback assistant text',
        assistantContentBlocks: assistantBlocks,
        userContentBlocks: userBlocks,
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    // user message should carry the structured blocks (tool_result), NOT the fallback string
    expect(msgs![0]).toEqual({ role: 'user', content: userBlocks });
    // assistant message should carry the full block array (thinking + text + tool_use)
    expect(msgs![1]).toEqual({ role: 'assistant', content: assistantBlocks });
  });

  it('uses userContentBlocks independently even when assistantContentBlocks is absent', () => {
    const userBlocks: ContentBlockParam[] = [
      { type: 'text', text: 'structured user content' },
    ];
    const history: ResumeHistoryTurn[] = [
      { user: 'fallback text', assistant: 'assistant text', userContentBlocks: userBlocks },
    ];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs![0]).toEqual({ role: 'user', content: userBlocks });
    // assistant falls back to text since no assistantContentBlocks
    expect(msgs![1]).toEqual({ role: 'assistant', content: 'assistant text' });
  });

  it('uses assistantContentBlocks independently even when userContentBlocks is absent', () => {
    const assistantBlocks: ContentBlockParam[] = [
      { type: 'text', text: 'structured assistant content' },
    ];
    const history: ResumeHistoryTurn[] = [
      { user: 'user text', assistant: 'fallback', assistantContentBlocks: assistantBlocks },
    ];
    const msgs = resumeHistoryToMessages(history);
    // user falls back to text
    expect(msgs![0]).toEqual({ role: 'user', content: 'user text' });
    expect(msgs![1]).toEqual({ role: 'assistant', content: assistantBlocks });
  });

  it('falls back to text when contentBlocks arrays are empty', () => {
    const history: ResumeHistoryTurn[] = [
      {
        user: 'text user',
        assistant: 'text assistant',
        userContentBlocks: [],
        assistantContentBlocks: [],
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs).toEqual([
      { role: 'user', content: 'text user' },
      { role: 'assistant', content: 'text assistant' },
    ]);
  });

  it('mixes structured and text-only turns across multi-turn history', () => {
    const assistantBlocks: ContentBlockParam[] = [{ type: 'text', text: 'structured' }];
    const history: ResumeHistoryTurn[] = [
      { user: 'old q', assistant: 'old a' },          // text-only (old sidecar)
      {
        user: 'new q',
        assistant: 'new a',
        assistantContentBlocks: assistantBlocks,
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs).toHaveLength(4);
    expect(msgs![0]).toEqual({ role: 'user', content: 'old q' });
    expect(msgs![1]).toEqual({ role: 'assistant', content: 'old a' });
    expect(msgs![2]).toEqual({ role: 'user', content: 'new q' });
    expect(msgs![3]).toEqual({ role: 'assistant', content: assistantBlocks });
  });

  // ── Security: invalid blocks from corrupted sidecars are filtered (#2003) ─

  it('filters out blocks with unknown types from corrupted/crafted sidecars', () => {
    // Simulates a sidecar tampered by an attacker: a valid text block is mixed
    // with a block carrying an unrecognised type. Only the text block should reach
    // the API; the crafted block must be dropped.
    const history: ResumeHistoryTurn[] = [
      {
        user: 'user prompt',
        assistant: 'fallback',
        assistantContentBlocks: [
          { type: 'text', text: 'legitimate reply' },
          { type: 'injected_malicious' as 'text', text: 'attacker payload' },
        ] as ContentBlockParam[],
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    expect(msgs).toHaveLength(2);
    const assistantContent = msgs![1].content;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect(assistantContent).toHaveLength(1);
    expect((assistantContent as ContentBlockParam[])[0]).toEqual({ type: 'text', text: 'legitimate reply' });
  });

  it('falls back to text when all structured blocks are filtered out due to invalid types', () => {
    // If every block in userContentBlocks is invalid, the message should fall
    // back to the text-only path rather than emitting an empty content array.
    const history: ResumeHistoryTurn[] = [
      {
        user: 'fallback user text',
        assistant: 'fallback assistant text',
        userContentBlocks: [
          { type: 'unknown_evil_type' as 'text', text: 'bad' },
        ] as ContentBlockParam[],
        assistantContentBlocks: [
          { type: 'another_unknown' as 'text', text: 'also bad' },
        ] as ContentBlockParam[],
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    // Both block arrays fully filtered → text fallback path
    expect(msgs).toEqual([
      { role: 'user', content: 'fallback user text' },
      { role: 'assistant', content: 'fallback assistant text' },
    ]);
  });

  it('drops null and non-object entries mixed into sidecar block arrays', () => {
    // Defensive: ensure null entries inside the raw array do not crash the
    // filter and are silently removed.
    const history: ResumeHistoryTurn[] = [
      {
        user: 'u',
        assistant: 'a',
        userContentBlocks: [
          null as unknown as ContentBlockParam,
          { type: 'text', text: 'valid' },
          'stray string' as unknown as ContentBlockParam,
        ],
      },
    ];
    const msgs = resumeHistoryToMessages(history);
    const userContent = msgs![0].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent).toHaveLength(1);
    expect((userContent as ContentBlockParam[])[0]).toEqual({ type: 'text', text: 'valid' });
  });
});

describe('hasValidToolUsePairing (#2004 — only nextUserBlocks, not currentUserBlocks)', () => {
  // Shared test fixtures
  const toolUseBlock = (id: string): ContentBlockParam =>
    ({ type: 'tool_use', id, name: 'bash', input: {} } as ContentBlockParam);
  const toolResultBlock = (toolUseId: string): ContentBlockParam =>
    ({ type: 'tool_result', tool_use_id: toolUseId, content: 'result' } as ContentBlockParam);
  const textBlock: ContentBlockParam = { type: 'text', text: 'some text' };

  // ── Trivial satisfactions ─────────────────────────────────────────────

  it('returns true when assistantBlocks has no tool_use blocks (pairing trivially satisfied)', () => {
    const assistantBlocks: ContentBlockParam[] = [textBlock];
    expect(hasValidToolUsePairing(assistantBlocks, undefined)).toBe(true);
    expect(hasValidToolUsePairing(assistantBlocks, [])).toBe(true);
    expect(hasValidToolUsePairing([], undefined)).toBe(true);
  });

  // ── Normal case: tool_result in nextUserBlocks satisfies pairing ──────

  it('returns true when all tool_use ids are covered by tool_result in nextUserBlocks', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1'), toolUseBlock('tu_2')];
    const nextUserBlocks: ContentBlockParam[] = [
      toolResultBlock('tu_1'),
      toolResultBlock('tu_2'),
    ];
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(true);
  });

  it('returns true when nextUserBlocks has extra tool_result blocks beyond what is needed', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1')];
    const nextUserBlocks: ContentBlockParam[] = [
      toolResultBlock('tu_1'),
      toolResultBlock('tu_extra'), // unrelated extra result — should not affect verdict
    ];
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(true);
  });

  it('returns true when nextUserBlocks contains a mix of text and matching tool_result blocks', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1')];
    const nextUserBlocks: ContentBlockParam[] = [textBlock, toolResultBlock('tu_1')];
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(true);
  });

  // ── False-positive prevention: tool_result in currentUserBlocks must NOT satisfy ──

  it('returns false when the matching tool_result is only in currentUserBlocks (false-positive prevention)', () => {
    // This is the key regression guard for #2004. A tool_result from a PRIOR
    // tool exchange sits in the preceding user turn. The old dual-search would
    // have counted it as satisfying the pairing for the current assistant turn's
    // tool_use blocks — producing a false positive. The narrowed function must
    // return false here because nextUserBlocks has no matching result.
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1')];
    // The function signature only accepts `nextUserBlocks` — `currentUserBlocks`
    // is never a parameter. This test verifies that an empty next-turn yields
    // `false`, which is the structural guarantee preventing the false-positive
    // that a dual-search function would allow.
    const nextUserBlocks: ContentBlockParam[] = []; // no result in the next turn
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(false);
  });

  it('returns false when nextUserBlocks is undefined (no following user turn exists)', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1')];
    expect(hasValidToolUsePairing(assistantBlocks, undefined)).toBe(false);
  });

  // ── Partial coverage ──────────────────────────────────────────────────

  it('returns false when only some tool_use ids are covered in nextUserBlocks', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1'), toolUseBlock('tu_2')];
    const nextUserBlocks: ContentBlockParam[] = [toolResultBlock('tu_1')]; // tu_2 missing
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(false);
  });

  it('returns false when nextUserBlocks has tool_result blocks but none match the tool_use ids', () => {
    const assistantBlocks: ContentBlockParam[] = [toolUseBlock('tu_1')];
    const nextUserBlocks: ContentBlockParam[] = [toolResultBlock('tu_unrelated')];
    expect(hasValidToolUsePairing(assistantBlocks, nextUserBlocks)).toBe(false);
  });
});
