# Provider Accounting Parity Audit

**Issue:** #2424  
**Date:** 2026-09-30  
**Scope:** Cost, token-usage, and context-usage accounting across `anthropic-direct`, `openai-compatible` (and its xAI sub-provider), with attention to cached-input pricing, reasoning tokens, `getContextUsage()` parity, and auto-compact trigger skew.

---

## Executive Summary

All four items in the issue scope were audited. Two areas have divergences documented below:
- **Item 3b (auto-compact model id)** — openai-compatible uses `currentModel` (wire id) where anthropic-direct uses `requestedModel` (alias) for the `autoCompactLimitFor` lookup. Harmless for current OpenAI model set (no `_1m` aliases), but structurally inconsistent. Disposition: **follow-up** (no known practical impact today).
- **Item 4 (reasoning tokens in outputTokens)** — o-series reasoning tokens are billed as part of `completion_tokens` and thus already rolled into `outputTokens`; no double-counting or undercounting occurs. But the `completion_tokens_details.reasoning_tokens` sub-field (when provided) is not surfaced in `ProviderUsage`. Disposition: **follow-up** (display gap, not a billing gap).

Everything else — cached-input pricing semantics, `contextWindowTokens` computation, local/unknown model handling — is consistent and correct.

---

## Item 1 — Cost: Cached-Input and Reasoning-Token Pricing

### 1a. Anthropic-direct: cache-write TTL split (`anthropic-direct/pricing.ts`)

**What it does:**  
`deriveCallCostUsd` (pricing.ts:244) accepts a `CacheWriteSplit` with `ephemeral5m`/`ephemeral1h` fields and applies separate multipliers: `CACHE_WRITE_5M_MULTIPLIER = 1.25` (pricing.ts:46) and `CACHE_WRITE_1H_MULTIPLIER = 2.0` (pricing.ts:48). The split is resolved by `resolveCacheWriteSplit` in `usage.ts:40`, which prefers the API's own `usage.cache_creation` breakdown and falls back to `getCacheTtl()` (defaults to `1h`). Cache-read multiplier is `0.1×` by default, with per-model overrides in the pricing table.

**Key invariant (pricing.ts:17-41):**  
`input_tokens` from the Anthropic API EXCLUDES cache reads and writes. So `inputTokens` is passed verbatim (not pre-subtracted) to the cost formula, and cache fields are added separately.

**Reasoning tokens (Anthropic):**  
Anthropic's extended thinking tokens appear in `output_tokens` — no separate billing field. No pricing adjustment needed.

**Verdict:** ✅ Correct.

---

### 1b. OpenAI-compatible: cached-input pricing (`openai-compatible/pricing.ts`)

**What it does:**  
`deriveCallCostUsd` (pricing.ts:144) receives `inputTokens` (the full `prompt_tokens`), `outputTokens` (`completion_tokens`), and `cachedInputTokens` (from `prompt_tokens_details.cached_tokens`). The plain-rate portion is `inputTokens - cachedInputTokens` (pricing.ts:160), and the cached portion uses `cachedInputPerMTok` (or falls back to the base rate). This correctly avoids double-billing.

**Key divergence from Anthropic (documented in code):**  
OpenAI's `prompt_tokens` INCLUDES cached tokens (they are a subset), so the formula subtracts before applying the base rate. Anthropic's `input_tokens` EXCLUDES cache. Both formulas compute the same economic result — they differ in what the wire count means, not in correctness.

**Local/unknown models:** Both providers return `undefined` for unrecognized model ids — never `0`. This is the correct "unknown" sentinel per issue #865/#866.

**Reasoning tokens (OpenAI):**  
o-series models report `completion_tokens_details.reasoning_tokens` as a sub-field of `completion_tokens`. The current `OpenAIChunk.usage` type (`translate.ts:54-58`) does not capture `completion_tokens_details`. However, reasoning tokens ARE included in `completion_tokens` and therefore in `outputTokens`. Cost is computed correctly at the `outputPerMTok` rate — reasoning tokens are billed at the same rate as visible output on OpenAI's published pricing. No billing gap exists.

**Display gap (follow-up):** `completion_tokens_details.reasoning_tokens` is not broken out in `ProviderUsage`, so the `/tokens` command cannot separately show "reasoning tokens" for o-series models. This is a display gap, not a cost gap.

**Cache-write fees (OpenAI):**  
OpenAI charges separately for cache writes (1.25× input rate), but this is NOT currently modeled in `openai-compatible/pricing.ts`. The module docstring (pricing.ts:51-57) acknowledges this explicitly: the per-call context required to distinguish a cache-prime vs cache-hit request is not available in the usage block. Disposition: **follow-up**, known limitation documented in source.

**Verdict:** ✅ Correct (billing). ⚠️ Display gap for reasoning tokens sub-breakdown (follow-up).

---

### 1c. Local runners (cost = `undefined`)

Both providers return `undefined` when a model is absent from the pricing table (e.g., `mlx-community/qwen3-30b`). This is the correct "cost unavailable" sentinel. Callers must not coerce `undefined` to `0`.

**Verdict:** ✅ Consistent.

---

## Item 2 — `getContextUsage()` and Usage Field Semantics

### 2a. `contextWindowTokens` computation (provider-by-provider)

**Anthropic-direct (`loop/turn-accumulator.ts:119-126`):**
```
contextWindowTokens = input + output + cachedInput + cacheCreation
```
This is the full window occupancy for the LAST round. Anthropic's `input_tokens` excludes cache, so all four fields must be summed to get the true window footprint.

**OpenAI-compatible (`query/turn-driver.ts:185-187`):**
```
contextWindowTokens = input + output
```
This is correct for OpenAI because `prompt_tokens` already includes cached tokens (they are a subset, not additive). Adding `cachedInputTokens` again would double-count them.

Both computations are described in the `ProviderUsage.contextWindowTokens` docstring (`provider.ts:74-87`). The difference is intentional and correct.

**Verdict:** ✅ Intentional divergence, correctly documented.

---

### 2b. `getContextUsage()` surface: both providers

Both providers ultimately call `buildContextUsageFields(last)` (`shared/context-usage-fields.ts:109`) to populate `apiUsage` and `totalTokens`. Both use `contextWindowTokensUsed(last)` (which prefers `contextWindowTokens` over the `input + output` fallback) for the percentage calculation.

**Anthropic-direct** (`query-capabilities.ts:42`): reads `state.lastUsage`, looks up context limit via `state.requestedModel`.  
**OpenAI-compatible** (`query.ts:431`): reads `this.lastUsage`, looks up context limit via `this.currentModel`.

**Subtle difference:** anthropic-direct uses `requestedModel` (the alias, e.g., `sonnet_1m`) for the context-limit lookup, which correctly resolves 1M-context aliases. OpenAI-compatible uses `currentModel` (the wire id). Since OpenAI has no `_1m`-style aliases, this makes no practical difference today.

**`apiUsage` field mapping (`context-usage-fields.ts:117-124`):**
- `cache_read_input_tokens` ← `last.cachedInputTokens`
- `cache_creation_input_tokens` ← `last.cacheCreationTokens`

For OpenAI, `cachedInputTokens` is populated from `prompt_tokens_details.cached_tokens` (`translate.ts:198`). For Anthropic, from `usage.cache_read_input_tokens` (`usage.ts:90`). The field names differ at the wire but map to the same `ProviderUsage` field — `cachedInputTokens` always means "tokens served from cache."

**Verdict:** ✅ Semantically consistent. See Item 3b for the `autoCompactLimitFor` model-id skew.

---

## Item 3 — Auto-Compact Trigger Skew (`shared/auto-compact.ts`)

### 3a. `shouldAutoCompact` logic

Both providers use the same `shouldAutoCompact(usedTokens, contextLimit, threshold)` function (`shared/auto-compact.ts:45`). No divergence.

### 3b. `autoCompactLimitFor` model id used (skew)

**Anthropic-direct** (`query-turn-driver.auto-compact.ts:39`):
```ts
const compactionLimit = autoCompactLimitFor(ctx.state.requestedModel);
```

**OpenAI-compatible** (`query.ts:322`):
```ts
const compactionLimit = autoCompactLimitFor(this.currentModel);
```

`autoCompactLimitFor` checks for `_1m` suffix to bypass the reduced compaction budget for base `sonnet`/`opus`. With anthropic-direct, a `sonnet_1m` alias correctly uses the full 1M window; with OpenAI-compatible, `currentModel` is always the resolved wire id (e.g., `gpt-4o-2024-08-06`), which has no `_1m` suffix.

**Impact today:** No practical impact because OpenAI models have no `_1m` variant in `autoCompactLimitFor`. If future OpenAI models gain `_1m` aliases, this could cause premature compaction.

**Disposition:** Follow-up — no urgency, but aligning both providers on `requestedModel` vs `currentModel` for the limit lookup would be cleaner.

### 3c. `getContextUsage()` percentage: same model-id skew

Anthropic-direct (`query-capabilities.ts:39`): `contextLimitFor(state.requestedModel)`.  
OpenAI-compatible (`query.ts:428`): `contextLimitFor(this.currentModel)`.

Same structural difference; same non-impact for today's OpenAI model set.

**Verdict:** ⚠️ Structural skew, no current practical impact. Follow-up.

---

## Item 4 — Reasoning Tokens in Usage Fields

**Anthropic extended thinking:** Thinking-block tokens are in `output_tokens`. No separate breakdown at the API level for cost purposes.

**OpenAI o-series reasoning:** `completion_tokens_details.reasoning_tokens` is a sub-field inside `completion_tokens`. It is NOT currently captured by `OpenAIChunk.usage.completion_tokens_details` (only `cached_tokens` under `prompt_tokens_details` is typed). However:
- Cost: reasoning tokens are already included in `completion_tokens` → `outputTokens`. At OpenAI's published rates, reasoning tokens are billed at the same rate as output tokens. No billing error.
- Display: the `/tokens` command cannot break out "reasoning: N tok" for o-series models.

**Verdict:** ✅ No billing gap. ⚠️ Display gap (follow-up).

---

## Fixes Applied in This PR

None. All divergences audited above are either:
- Intentional and documented in the source code (cache semantics between providers),
- Display gaps with no billing impact (reasoning token sub-breakdown), or
- Structural skews with no practical impact on today's model set (auto-compact model-id selection).

**The investigation reveals the codebase is in good shape.** The comments in `provider.ts`, `pricing.ts`, and `context-usage-fields.ts` already correctly describe the per-provider cache accounting differences.

---

## Follow-Up Items

| # | Area | File(s) | Description |
|---|------|---------|-------------|
| F1 | Auto-compact model id | `openai-compatible/query.ts:322`, `query.ts:428` | Use `opts.model` (the originally requested alias) instead of `currentModel` for `autoCompactLimitFor` and `contextLimitFor` to match the anthropic-direct `requestedModel` pattern. No-op today, future-proofs `_1m` aliases on OpenAI. |
| F2 | Reasoning token display | `openai-compatible/translate.ts` | Extend `OpenAIChunk['usage']` with `completion_tokens_details?: { reasoning_tokens?: number }` and surface as `ProviderUsage.reasoningTokens` for the `/tokens` breakdown. No billing impact. |
| F3 | OpenAI cache-write cost | `openai-compatible/pricing.ts` | Model cache-write fees (1.25× input) when per-call context signals are available. Currently documented as a known omission in the module's Contract note. |

---

## Tests Added

`src/agent/providers/conformance/provider-conformance.test.ts` — Scenarios S11 and S12:
- **S11** pins the `cachedInputTokens` semantics for both providers: Anthropic populates `cachedInputTokens` from `cache_read_input_tokens` (additive to `inputTokens`); OpenAI populates it from `prompt_tokens_details.cached_tokens` (a subset of `inputTokens`).
- **S12** pins the `contextWindowTokens` computation for both providers, asserting the field is set after a turn and reflects the correct per-provider formula.
