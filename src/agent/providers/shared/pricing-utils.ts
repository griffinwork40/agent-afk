/**
 * Shared pricing-lookup utilities for provider pricing modules.
 *
 * Both the `anthropic-direct` and `openai-compatible` providers resolve model
 * IDs against a dateless alias table, stripping a trailing dated-snapshot
 * suffix on a miss. The two providers use different date suffix patterns
 * (Anthropic: `/-\d{8}$/`; OpenAI: `/-\d{4}-\d{2}-\d{2}$/`), so the pattern
 * is a parameter rather than a constant — callers own their own regex and pass
 * it in.
 *
 * @module agent/providers/shared/pricing-utils
 */

/**
 * Clamp a wire-sourced numeric count to a finite, non-negative value.
 *
 * Contract: returns `n` unchanged when `n` is a finite number ≥ 0; otherwise
 * returns 0. All token-count parameters in `deriveCallCostUsd` implementations
 * must pass through this guard before use — a negative or NaN wire value must
 * not produce a negative or NaN cost total.
 */
export function clampPositive(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Resolve a model ID to its pricing row, with a single dated-snapshot retry.
 *
 * Contract: tries `pricingMap.get(model)` first. On a miss, strips one
 * trailing dated-snapshot suffix (governed by `dateSuffixPattern`) and retries
 * once against the same map. Returns `undefined` when neither the exact key
 * nor the stripped key is present — this never invents a mapping. The pattern
 * is caller-supplied so each provider can use its own suffix format without
 * this utility imposing a single regex on both.
 *
 * @param model              The model identifier to look up (exact wire id or
 *                           dateless alias).
 * @param pricingMap         The map of model ids to pricing rows.
 * @param dateSuffixPattern  A regex matching the trailing dated-snapshot
 *                           portion of a model id (e.g. `/-\d{8}$/` for
 *                           Anthropic or `/-\d{4}-\d{2}-\d{2}$/` for OpenAI).
 *                           Must only match at the end of the string.
 */
export function lookupPricing<T>(
  model: string,
  pricingMap: ReadonlyMap<string, T>,
  dateSuffixPattern: RegExp,
): T | undefined {
  const exact = pricingMap.get(model);
  if (exact) return exact;
  const base = model.replace(dateSuffixPattern, '');
  return base === model ? undefined : pricingMap.get(base);
}
