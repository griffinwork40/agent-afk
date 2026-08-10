/**
 * Static pricing table + per-call cost derivation for the `openai-compatible`
 * provider.
 *
 * Mirrors the shape of `anthropic-direct/pricing.ts` on purpose — same
 * `Map<string, ModelPricing>` table, same "exact match, else undefined"
 * lookup contract, same rule that an unpriced model returns `undefined` cost
 * rather than a silent zero (see issue #865/#866: coalescing "unknown" into
 * `0` is the exact defect this table exists to fix). This module is simpler
 * than its Anthropic sibling because the OpenAI-compatible surface has no
 * cache-write TTL tiers or Fast-mode multiplier to account for — only a flat
 * discounted rate for prompt-cache hits.
 *
 * Invariant: a HuggingFace-style `org/model` id (`mlx-community/…`, `Qwen/…`)
 * served by a local OpenAI-shim runner (MLX, llama.cpp, vLLM, ollama-openai)
 * is genuinely free — but this same provider also serves OpenRouter-style
 * `org/model` ids (`openai/o3`, per `model-capabilities.ts:bareModelId`),
 * which DO cost money. A slash-in-the-id heuristic cannot safely tell those
 * two apart, and mispricing a paid OpenRouter call as a free local one would
 * reproduce the exact "real spend reported as $0" defect this table exists
 * to fix. So this module makes no local-runner special case: EVERY model
 * absent from {@link MODEL_PRICING} — local shim or otherwise — prices as
 * `undefined` (unknown), never `0`. A future PR that wants free-by-default
 * local pricing should key it off something more specific than "has a
 * slash" (an explicit allowlist, or a config flag scoped to the local
 * base-URL) rather than widening this heuristic.
 *
 * @module agent/providers/openai-compatible/pricing
 */

/**
 * Rates are USD per 1 million tokens.
 *
 * MAINTENANCE: these are OpenAI's publicly announced list prices as of
 * 2025-04 (the gpt-4.1 launch window), extended 2026-08 to include the
 * historical o1-preview alias and o1-pro — recorded from prior knowledge per
 * this task's constraint against live pricing-page lookups — NOT re-verified
 * against a live pricing page at authoring time. Update this table whenever
 * OpenAI revises rates or ships a new model family; an unknown model yields
 * `undefined` cost (never zero) — see {@link deriveCallCostUsd}.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Discounted rate for cached input tokens (default: no discount, i.e. inputPerMTok). */
  cachedInputPerMTok?: number;
}

/** @internal exported only for unit tests */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
  // GPT-4o family.
  ['gpt-4o', { inputPerMTok: 2.5, outputPerMTok: 10.0, cachedInputPerMTok: 1.25 }],
  ['gpt-4o-mini', { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 }],
  // GPT-4.1 family (GA 2025-04-14).
  ['gpt-4.1', { inputPerMTok: 2.0, outputPerMTok: 8.0, cachedInputPerMTok: 0.5 }],
  ['gpt-4.1-mini', { inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.1 }],
  ['gpt-4.1-nano', { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.025 }],
  // o-series reasoning models.
  ['o1', { inputPerMTok: 15.0, outputPerMTok: 60.0, cachedInputPerMTok: 7.5 }],
  ['o1-preview', { inputPerMTok: 15.0, outputPerMTok: 60.0, cachedInputPerMTok: 7.5 }],
  ['o1-pro', { inputPerMTok: 150.0, outputPerMTok: 600.0 }], // No caching discount.
  ['o1-mini', { inputPerMTok: 3.0, outputPerMTok: 12.0, cachedInputPerMTok: 1.5 }],
  ['o3', { inputPerMTok: 2.0, outputPerMTok: 8.0, cachedInputPerMTok: 0.5 }],
  ['o3-mini', { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 }],
  ['o4-mini', { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.275 }],
]);

/**
 * Trailing `-YYYY-MM-DD` wire-id snapshot suffix, e.g. the `-2024-08-06` in
 * `gpt-4o-2024-08-06`. OpenAI's Chat Completions / Responses APIs echo the
 * concrete dated snapshot actually served even when the request named the
 * dateless alias, so a table keyed by alias needs this stripped to match.
 * Anthropic's equivalent (`anthropic-direct/pricing.ts:DATE_SUFFIX`) is an
 * 8-digit run with no separators; OpenAI's uses dashes, hence the distinct
 * pattern rather than a shared one.
 */
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Contract: exact match first; on a miss, strip one trailing dated-snapshot
 * suffix and retry against the same table. Mirrors
 * `anthropic-direct/pricing.ts:lookupPricing` — a model matching neither form
 * returns `undefined`; this never invents a mapping.
 */
function lookupPricing(model: string): ModelPricing | undefined {
  const lowered = model.trim().toLowerCase();
  const exact = MODEL_PRICING.get(lowered);
  if (exact) return exact;
  const base = lowered.replace(DATE_SUFFIX, '');
  return base === lowered ? undefined : MODEL_PRICING.get(base);
}

/**
 * Contract: returns the USD cost of ONE API call, or `undefined` when the
 * model is absent from {@link MODEL_PRICING} — callers must treat `undefined`
 * as "cost unavailable" and must never coerce it to zero. See the module
 * docstring for why this includes local OpenAI-shim models rather than
 * special-casing them to a deliberate zero.
 *
 * `inputTokens` must be the raw `usage.prompt_tokens` (Chat Completions) or
 * `usage.input_tokens` (Responses) total. Unlike Anthropic — where
 * `input_tokens` EXCLUDES cache — OpenAI's total already INCLUDES cached
 * tokens (`cachedInputTokens` is a subset of it; see the `contextWindowTokens`
 * docstring on `ProviderUsage` in `provider.ts`). So the plain-rate portion
 * priced here is `inputTokens - cachedInputTokens`, not `inputTokens` verbatim
 * — pricing the full total at the plain rate would double-bill the cached
 * slice on top of its discounted rate.
 *
 * Pure: no env reads, no clock. All token-count parameters are clamped to
 * finite, non-negative values before use, and `cachedInputTokens` is further
 * clamped to never exceed `inputTokens` so a malformed usage block cannot
 * drive the plain-rate portion negative.
 *
 * @internal exported for unit tests
 */
export function deriveCallCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | undefined {
  const pricing = lookupPricing(model);
  if (!pricing) return undefined;

  const M = 1_000_000;
  const clamp = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0);
  const safeInput = clamp(inputTokens);
  const safeOutput = clamp(outputTokens);
  const safeCached = Math.min(clamp(cachedInputTokens), safeInput);
  const plainInput = safeInput - safeCached;

  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const inputCost = (plainInput / M) * pricing.inputPerMTok;
  const cachedCost = (safeCached / M) * cachedRate;
  const outputCost = (safeOutput / M) * pricing.outputPerMTok;

  return inputCost + cachedCost + outputCost;
}
