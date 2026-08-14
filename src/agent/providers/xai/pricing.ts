/**
 * Static pricing table for metered xAI API (Grok) models.
 *
 * Rates from https://docs.x.ai/developers/models (public list prices as of
 * 2026-08). Long-context surcharges (≥200k prompt) are NOT modeled here —
 * only the standard-rate tier. Unknown models yield `undefined` cost, never
 * silent `$0`.
 *
 * Contract: SuperGrok / SuperGrok Heavy / X Premium+ **subscription OAuth**
 * usage may not map to these metered rates; callers still may report cost
 * estimates under API-key mode. Prefer treating OAuth cost as unknown in UX
 * when auth source is `xai-oauth`.
 *
 * @module agent/providers/xai/pricing
 */

import { clampPositive, lookupPricing as sharedLookupPricing } from '../shared/pricing-utils.js';

export interface XaiModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
}

/**
 * USD per 1M tokens — standard (prompt &lt; 200k) list rates from xAI docs.
 * @internal exported for unit tests
 */
export const XAI_MODEL_PRICING: ReadonlyMap<string, XaiModelPricing> = new Map([
  // Active set only (docs.x.ai models/pricing, 2026-08). Retired families
  // (grok-2/3, bare grok-4, grok-4-fast, …) are omitted — unknown ids price as
  // undefined, never silent $0.
  // Flagship coding / agentic (500k context). Newest public SKU first.
  ['grok-4.6', { inputPerMTok: 2.0, outputPerMTok: 6.0, cachedInputPerMTok: 0.5 }],
  ['grok-4.5', { inputPerMTok: 2.0, outputPerMTok: 6.0, cachedInputPerMTok: 0.3 }],
  // General-purpose long context (1M).
  ['grok-4.3', { inputPerMTok: 1.25, outputPerMTok: 2.5, cachedInputPerMTok: 0.2 }],
  // Grok 4.20 family (1M) — dated multi-agent / reasoning SKUs.
  ['grok-4.20-0309-reasoning', { inputPerMTok: 1.25, outputPerMTok: 2.5, cachedInputPerMTok: 0.2 }],
  ['grok-4.20-0309-non-reasoning', { inputPerMTok: 1.25, outputPerMTok: 2.5, cachedInputPerMTok: 0.2 }],
  ['grok-4.20-multi-agent-0309', { inputPerMTok: 1.25, outputPerMTok: 2.5, cachedInputPerMTok: 0.2 }],
  // Build / coding specialist (256k).
  ['grok-build-0.1', { inputPerMTok: 1.0, outputPerMTok: 2.0, cachedInputPerMTok: 0.2 }],
]);

const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Normalises the model id to lowercase before delegating to
 * {@link sharedLookupPricing} with this provider's {@link DATE_SUFFIX} pattern,
 * preserving the original trim-and-lowercase contract of this module.
 */
function lookupXaiPricing(model: string): XaiModelPricing | undefined {
  const lowered = model.trim().toLowerCase();
  return sharedLookupPricing(lowered, XAI_MODEL_PRICING, DATE_SUFFIX);
}

/** True when the id looks like a Grok / xAI chat model. */
export function isGrokModelId(model: string): boolean {
  const lowered = model.trim().toLowerCase();
  return lowered === 'grok' || lowered.startsWith('grok-') || lowered.startsWith('grok_');
}

/**
 * Contract: USD cost of one call, or `undefined` when the model is unpriced.
 * Never returns `0` for an unknown model.
 */
export function deriveXaiCallCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | undefined {
  const pricing = lookupXaiPricing(model);
  if (!pricing) return undefined;

  const M = 1_000_000;
  const safeInput = clampPositive(inputTokens);
  const safeOutput = clampPositive(outputTokens);
  const safeCached = Math.min(clampPositive(cachedInputTokens), safeInput);
  const plainInput = safeInput - safeCached;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  return (
    (plainInput / M) * pricing.inputPerMTok +
    (safeCached / M) * cachedRate +
    (safeOutput / M) * pricing.outputPerMTok
  );
}
