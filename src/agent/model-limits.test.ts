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

import { describe, it, expect, vi } from 'vitest';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from './model-limits.js';
import { resolveEffectiveMaxOutputTokens } from './providers/openai-compatible/query/model-params.js';
import { resolveMaxTokens } from './providers/anthropic-direct/resolve-params.js';
import type { AgentConfig } from './types/config-types.js';

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

describe('resolveEffectiveMaxOutputTokens — over-ceiling clamp + cross-provider parity (#953)', () => {
  // The openai-compatible path used to forward an over-ceiling cap verbatim and
  // let the provider 400 it, while anthropic-direct clamped down to the ceiling.
  // Same config key, same intent, two outcomes. These pin the fixed contract:
  // both providers resolve the SAME number for the same (model, cap) — for
  // models with a KNOWN ceiling. See the "does NOT clamp ... unknown/
  // provider-prefixed model id" test below for the deliberate exception (no
  // guessed-ceiling clamp).
  const cfg = (maxOutputTokens?: number): AgentConfig =>
    ({ maxOutputTokens } as unknown as AgentConfig);

  it('clamps an over-ceiling cap down to the model ceiling, warning exactly once', () => {
    const model = 'gpt-5.6'; // 128k ceiling, known
    const ceiling = maxOutputTokensFor(model);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveEffectiveMaxOutputTokens(model, ceiling + 500_000)).toBe(ceiling);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // The dedupe Set is keyed by (model, requested) and is module-scope, so a
      // second call with the SAME pair must not warn again — order matters:
      // this asserts it within one test (two calls, same args) rather than
      // relying on cross-test ordering, so it can't flake against test order.
      expect(resolveEffectiveMaxOutputTokens(model, ceiling + 500_000)).toBe(ceiling);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the 64k DEFAULT_MAX_OUTPUT guess for unlisted local runners when no explicit cap is given', () => {
    const local = 'mlx-community/some-local-model'; // unlisted → 64k guess
    const ceiling = maxOutputTokensFor(local);
    expect(ceiling).toBe(64_000);
    expect(resolveEffectiveMaxOutputTokens(local, undefined)).toBe(64_000);
  });

  it('does NOT clamp an explicit over-64k cap for an unknown/provider-prefixed model id (regression guard)', () => {
    // Any `/`-prefixed id routes to this provider (providers/index.ts) but most
    // are NOT in MODEL_MAX_OUTPUT_TOKENS — so the 64k DEFAULT_MAX_OUTPUT is a
    // guess, not a documented ceiling. Before this guard, an explicit
    // --max-output-tokens above 64k on e.g. mlx-community/<model> was silently
    // clamped down to the guess; the fix forwards it unchanged instead, since
    // clamping to a guessed limit doesn't prevent a provider 400 — it just
    // silently degrades a request the provider might actually honour.
    for (const model of ['mlx-community/some-model', 'openrouter/gpt-5.5']) {
      expect(resolveEffectiveMaxOutputTokens(model, 128_000), model).toBe(128_000);
    }
  });

  it('returns the same number as anthropic-direct resolveMaxTokens for the same (model, cap)', () => {
    const model = 'gpt-5.6';
    const ceiling = maxOutputTokensFor(model);
    for (const cap of [undefined, 8_000, ceiling, ceiling + 500_000, Number.POSITIVE_INFINITY]) {
      expect(resolveEffectiveMaxOutputTokens(model, cap), `cap=${cap}`).toBe(
        resolveMaxTokens(cfg(cap), model),
      );
    }
  });

  it('returns the same number as anthropic-direct resolveMaxTokens for a non-adaptive Anthropic model (haiku)', () => {
    // The test above only exercised gpt-5.6 (openai-compatible-routed). This
    // covers the non-adaptive Anthropic family on the SAME openai-compatible
    // helper, pinning that the parity invariant isn't accidentally gpt-5.x-only.
    const model = 'claude-haiku-4-5-20251001'; // known 64k ceiling, non-adaptive
    const ceiling = maxOutputTokensFor(model);
    for (const cap of [undefined, 8_000, ceiling, ceiling + 500_000, Number.POSITIVE_INFINITY]) {
      expect(resolveEffectiveMaxOutputTokens(model, cap), `cap=${cap}`).toBe(
        resolveMaxTokens(cfg(cap), model),
      );
    }
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
    // Same reasoning, same ceiling, for the other two Active 1M-window opus
    // generations — both were missing and inheriting the 64k fallback.
    expect(maxOutputTokensFor('claude-opus-4-7')).toBe(128_000);
    expect(maxOutputTokensFor('claude-opus-4-6')).toBe(128_000);
    // The new default resolves correctly too.
    expect(maxOutputTokensFor('claude-opus-5')).toBe(128_000);
    expect(maxOutputTokensFor('opus')).toBe(128_000);
  });

  it('reports the true 1M context window for the 4.6/4.7/4.8 opus wire ids', () => {
    // Invariant: this assertion previously pinned 200k, on the stated premise that
    // "the DEFAULT_CONTEXT_LIMIT (200k) fallback already yields opus-4-8's real
    // window." That premise was wrong. Anthropic's context-windows page lists Opus
    // 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5 and Sonnet 4.6 as 1M-window models
    // with 1M as the default and no beta header required, so relying on the
    // fallback under-reported all three opus generations by 5x.
    // <https://platform.claude.com/docs/en/build-with-claude/context-windows>
    expect(contextLimitFor('claude-opus-4-8')).toBe(1_000_000);
    expect(contextLimitFor('claude-opus-4-7')).toBe(1_000_000);
    expect(contextLimitFor('claude-opus-4-6')).toBe(1_000_000);
    // Opus 4.5 is absent from that 1M list, so it must KEEP the 200k fallback —
    // this is the negative control proving the fix is list-derived, not blanket.
    expect(contextLimitFor('claude-opus-4-5-20251101')).toBe(200_000);
  });

  it('keeps the 200k working budget for the 1M opus wire ids (no cost regression)', () => {
    // Contract: correcting the WINDOW must not move the COMPACTION TRIGGER. These
    // sessions compacted at 200k before the window fix; without matching
    // MODEL_AUTOCOMPACT_BUDGET entries they would have jumped to 1M — a real
    // cost/latency change smuggled in behind a bookkeeping correction. `opus_1m`
    // remains the explicit opt-in to the full window.
    expect(autoCompactLimitFor('claude-opus-4-8')).toBe(200_000);
    expect(autoCompactLimitFor('claude-opus-4-7')).toBe(200_000);
    expect(autoCompactLimitFor('claude-opus-4-6')).toBe(200_000);
    expect(autoCompactLimitFor('opus_1m')).toBe(1_000_000);
  });
});

describe('claude-sonnet-4-6 — explicit limit pins (A/B baseline vs claude-sonnet-5)', () => {
  // Invariant: 4.6 is not a first-class alias but IS reachable by raw wire id and
  // already priced (providers/anthropic-direct/pricing.ts). Both pins below now
  // DIFFER from the fallbacks they replace, so they guard real behaviour: 4.6
  // shares Sonnet 5's 1M window and 128k output ceiling, and inheriting either
  // fallback (200k context / 64k output) would under-report a live capability.
  it('pins the 128k output ceiling — the same as Sonnet 5, not half of it', () => {
    // First-party: migration guide, 4.6 → 5 — "128k max output tokens
    // (unchanged): Claude Sonnet 5 supports up to 128k output tokens, the same as
    // Claude Sonnet 4.6." A prior revision read Sonnet 5's "up from 64k on Sonnet
    // 4.6" comment as first-party and pinned 64k; that comment was itself wrong.
    expect(maxOutputTokensFor('claude-sonnet-4-6')).toBe(128_000);
    expect(maxOutputTokensFor('claude-sonnet-5')).toBe(128_000);
    // Guard the specific regression: 4.6 must not silently inherit the 64k
    // DEFAULT_MAX_OUTPUT fallback.
    expect(maxOutputTokensFor('claude-sonnet-4-6')).not.toBe(64_000);
  });

  it('pins the native 1M context window — GA, no `context-1m` beta header needed', () => {
    // A prior revision pinned 200k, reasoning that 1M on the 4.x line required a
    // `context-1m` beta this repo never sends. Stale: 1M is GA and per Anthropic
    // "you don't need a beta header" for any model with a 1M window — and Sonnet
    // 4.6 is named in that list. No beta entry was added to composeBetaHeader for
    // this, because none is required.
    expect(contextLimitFor('claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextLimitFor('claude-sonnet-5')).toBe(1_000_000);
  });

  it('takes the same 200k auto-compact budget as its Sonnet 5 sibling', () => {
    // Now that the window is truthfully 1M, the budget entry does real work:
    // Math.min(1M, 200k) bounds cost/latency on a long raw-wire-id session while
    // the status line still reports the true 1M window.
    expect(autoCompactLimitFor('claude-sonnet-4-6')).toBe(200_000);
    expect(autoCompactLimitFor('claude-sonnet-5')).toBe(200_000);
    // The budget is a policy cap, NOT the window — they must now diverge.
    expect(autoCompactLimitFor('claude-sonnet-4-6')).not.toBe(
      contextLimitFor('claude-sonnet-4-6'),
    );
  });

  it('the explicit `_1m` opt-in still bypasses the budget for a 4.6 session', () => {
    // `sonnet_1m` short-circuits on the literal suffix BEFORE wire-id resolution,
    // so the opt-out survives regardless of which id the sonnet family points at.
    expect(autoCompactLimitFor('sonnet_1m')).toBe(1_000_000);
  });
});
