/**
 * Tests for model-limits.ts: autoCompactLimitFor (per-model auto-compaction
 * working budget), contextLimitFor (context window), and maxOutputTokensFor
 * (output ceiling).
 *
 * Base `sonnet` and base `opus` have truthful 1M windows (see
 * MODEL_CONTEXT_LIMITS) but are capped at a 200k compaction budget so long
 * default sessions compact early for cost/latency. The `*_1m` opt-ins and every
 * model with no MODEL_AUTOCOMPACT_BUDGET entry use their full context window.
 * Note 200k means two different things here: a reduced budget for opus/sonnet,
 * but the real window for haiku. The GPT-5.6-family suites additionally guard the
 * output-cap path — provider-agnostic and shared with openai-compatible — so
 * new gpt-5.x ids do not silently fall through to the 64k default. See
 * src/agent/model-limits.ts.
 */

import { describe, it, expect } from 'vitest';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from './model-limits.js';
import { resolveEffectiveMaxOutputTokens } from './providers/openai-compatible/query/model-params.js';

describe('autoCompactLimitFor', () => {
  it('caps the default sonnet alias at the 200k working budget (not its 1M window)', () => {
    // The window is truthfully 1M; only the compaction trigger is reduced.
    expect(contextLimitFor('sonnet')).toBe(1_000_000);
    expect(autoCompactLimitFor('sonnet')).toBe(200_000);
  });

  it('caps the claude-sonnet-5 wire id at 200k (requestedModel may be the wire id)', () => {
    expect(autoCompactLimitFor('claude-sonnet-5')).toBe(200_000);
  });

  it('the sonnet_1m opt-in bypasses the budget and uses the full 1M window', () => {
    expect(autoCompactLimitFor('sonnet_1m')).toBe(1_000_000);
  });

  it('caps the default opus alias at the 200k working budget (not its 1M window)', () => {
    // Opus 5 ships a native 1M window, so base `opus` has the same profile as
    // base `sonnet`: truthful 1M window, reduced 200k compaction trigger. This
    // 200k is a CAP on a 1M window — not the window itself (contrast haiku
    // below, whose 200k is its actual window).
    expect(contextLimitFor('opus')).toBe(1_000_000);
    expect(autoCompactLimitFor('opus')).toBe(200_000);
  });

  it('caps the claude-opus-5 wire id at 200k (requestedModel may be the wire id)', () => {
    expect(autoCompactLimitFor('claude-opus-5')).toBe(200_000);
  });

  it('the opus_1m opt-in bypasses the budget and uses the full 1M window', () => {
    expect(autoCompactLimitFor('opus_1m')).toBe(1_000_000);
  });

  it('leaves haiku / fable at their full window (no budget entry)', () => {
    // haiku's 200k is its ACTUAL context window, not a reduced budget.
    expect(contextLimitFor('haiku')).toBe(200_000);
    expect(autoCompactLimitFor('haiku')).toBe(200_000);
    expect(autoCompactLimitFor('fable')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-fable-5')).toBe(1_000_000);
  });

  it('falls back to the model window for unknown / openai-compatible models', () => {
    expect(autoCompactLimitFor('gpt-4.1')).toBe(1_000_000);
    expect(autoCompactLimitFor('claude-xyz' as unknown as 'opus')).toBe(200_000);
    expect(autoCompactLimitFor('mlx-community/qwen3-32b-4bit')).toBe(128_000);
  });

  it('reports the explicit 1M window for the GPT-5.6 family (alias + all variants)', () => {
    // These are explicit MODEL_CONTEXT_LIMITS entries, not the 262k
    // openai-compatible fallback — a regression here means a gpt-5.6 id fell
    // through and would silently allow context overruns.
    for (const id of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
      expect(contextLimitFor(id), id).toBe(1_000_000);
      expect(autoCompactLimitFor(id), id).toBe(1_000_000);
    }
  });
});

describe('maxOutputTokensFor — GPT-5.6 family output ceiling', () => {
  const GPT_56_FAMILY = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

  it('reports the explicit 128k output cap (not the 64k DEFAULT_MAX_OUTPUT fallback)', () => {
    // maxOutputTokensFor is provider-agnostic and drives the openai-compatible
    // output cap too. Without explicit MODEL_MAX_OUTPUT_TOKENS entries these ids
    // fall through to DEFAULT_MAX_OUTPUT (64k) and silently halve the advertised
    // 128k output budget — the exact regression this asserts against.
    for (const id of GPT_56_FAMILY) {
      expect(maxOutputTokensFor(id), id).toBe(128_000);
    }
  });

  it('the openai-compatible request path resolves 128k when config.maxOutputTokens is unset', () => {
    // Mirrors query/model-params.ts:resolveEffectiveMaxOutputTokens, the actual
    // call site for public OpenAI-compatible requests (Chat Completions +
    // Responses). Undefined config → model ceiling, not 64k.
    for (const id of GPT_56_FAMILY) {
      expect(resolveEffectiveMaxOutputTokens(id, undefined), id).toBe(128_000);
    }
  });

  it('still honours an explicit config.maxOutputTokens override', () => {
    expect(resolveEffectiveMaxOutputTokens('gpt-5.6', 8_000)).toBe(8_000);
  });
});

describe('maxOutputTokensFor — retired-but-Active Opus pin', () => {
  it('keeps the 128k cap for the raw claude-opus-4-8 wire id (not the 64k fallback)', () => {
    // Opus 5 replaced opus-4-8 as the `opus`/`large` default, but 4.8 stays
    // Active per Anthropic's deprecation table and reachable by its wire id
    // (--model claude-opus-4-8 / config / env override). resolveModelInput
    // passes the wire id through unchanged, so dropping its explicit entry would
    // miss the table and fall to the 64k DEFAULT_MAX_OUTPUT — halving the real
    // 128k output cap. This guards that regression.
    expect(maxOutputTokensFor('claude-opus-4-8')).toBe(128_000);
    // The new default resolves correctly too.
    expect(maxOutputTokensFor('claude-opus-5')).toBe(128_000);
    expect(maxOutputTokensFor('opus')).toBe(128_000);
  });

  it('reports opus-4-8 true 200k context window via the raw wire id', () => {
    // No explicit MODEL_CONTEXT_LIMITS entry: the Anthropic DEFAULT_CONTEXT_LIMIT
    // (200k) fallback already yields opus-4-8's real window, so no regression on
    // the context path — documented here so the pin stays fully usable.
    expect(contextLimitFor('claude-opus-4-8')).toBe(200_000);
  });
});

describe('claude-sonnet-4-6 — explicit limit pins (A/B baseline vs claude-sonnet-5)', () => {
  // Invariant: 4.6 is not a first-class alias but IS reachable by raw wire id and
  // already priced (providers/anthropic-direct/pricing.ts). Both values below
  // equal the fallbacks they replace, so these tests pin INTENT, not a behaviour
  // change: they fail if someone edits DEFAULT_MAX_OUTPUT / DEFAULT_CONTEXT_LIMIT
  // or "upgrades" 4.6 to Sonnet 5's 1M window, either of which would silently
  // invalidate a 4.6-vs-5 A/B comparison.
  it('pins the 64k output ceiling (first-party: the Sonnet 5 entry says "up from 64k on Sonnet 4.6")', () => {
    expect(maxOutputTokensFor('claude-sonnet-4-6')).toBe(64_000);
    // Contrast: the Sonnet 5 sibling is double. An A/B that silently gave 4.6
    // Sonnet 5's ceiling would compare two different output budgets.
    expect(maxOutputTokensFor('claude-sonnet-5')).toBe(128_000);
  });

  it('pins the 200k context window — NOT Sonnet 5 1M (this repo sends no 1M beta header)', () => {
    // 1M on the 4.x line requires a `context-1m` beta this codebase never sends:
    // composeBetaHeader (providers/anthropic-direct/beta-headers.ts) emits a
    // closed set (OAuth, effort, extended-cache-ttl, fast-mode). Over-reporting
    // here would suppress auto-compaction and cause hard API errors mid-run.
    expect(contextLimitFor('claude-sonnet-4-6')).toBe(200_000);
    expect(contextLimitFor('claude-sonnet-5')).toBe(1_000_000);
  });

  it('takes NO auto-compact budget entry: 200k is its real window, not a cap (haiku precedent)', () => {
    // MODEL_AUTOCOMPACT_BUDGET exists to cap a 1M window down to a 200k working
    // budget. 4.6's window IS 200k, so an entry would be Math.min(200k, 200k) —
    // a no-op that falsely implies a larger window is being throttled. Same
    // reasoning as haiku above, which is deliberately absent from the table.
    expect(autoCompactLimitFor('claude-sonnet-4-6')).toBe(200_000);
    expect(autoCompactLimitFor('claude-sonnet-4-6')).toBe(contextLimitFor('claude-sonnet-4-6'));
  });
});
