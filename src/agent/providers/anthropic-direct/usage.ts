/**
 * Normalization of one Anthropic `Usage` into the harness-facing
 * `ProviderUsage`, including per-call cost derivation.
 *
 * This module is the single env-reading boundary for pricing: `pricing.ts`
 * stays pure (no env, no clock) so its golden-rate tests cannot drift with
 * ambient config, and the one piece of local configuration that cost depends
 * on — the configured cache TTL — is resolved here.
 *
 * @module agent/providers/anthropic-direct/usage
 */

import type { Usage } from '@anthropic-ai/sdk/resources';
import type { ProviderUsage } from '../../provider.js';
import { getCacheTtl } from './cache-policy.js';
import {
  deriveCallCostUsd,
  type AnthropicSpeed,
  type CacheWriteSplit,
} from './pricing.js';

/** Narrowly accept only the speed values documented by Anthropic. */
function observedSpeed(usage: Usage): AnthropicSpeed | undefined {
  const value = (usage as unknown as { speed?: unknown }).speed;
  return value === 'fast' || value === 'standard' ? value : undefined;
}

/**
 * Contract: split this call's cache-write tokens by the TTL they were billed
 * at, so `deriveCallCostUsd` can apply 1.25× (5m) vs 2× (1h) correctly.
 *
 * Prefers the API's own `usage.cache_creation` breakdown — that is what was
 * actually billed, and it is the only source that stays right when a request
 * mixes TTLs. Falls back to attributing every write token to the locally
 * configured TTL (`getCacheTtl()`), which is correct for this provider because
 * `cache-policy.ts` stamps every breakpoint in a request with that one TTL.
 * The fallback matters: without it an endpoint that omits `cache_creation`
 * would be priced at 5m rates while `AFK_PROMPT_CACHE_TTL` defaults to `1h`.
 */
function resolveCacheWriteSplit(usage: Usage): CacheWriteSplit {
  // Invariant: the SDK types every field read below as a required `number`,
  // but that is a compile-time guarantee only — a malformed response (or a
  // hand-built fixture) could still carry a negative or NaN count, which
  // would propagate into a negative/NaN totalCostUsd downstream. Clamp here
  // so both branches below (explicit breakdown vs. total-only fallback)
  // return only finite, non-negative counts.
  const clampCount = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0);
  const breakdown = usage.cache_creation;
  if (breakdown) {
    return {
      ephemeral5m: clampCount(breakdown.ephemeral_5m_input_tokens ?? 0),
      ephemeral1h: clampCount(breakdown.ephemeral_1h_input_tokens ?? 0),
    };
  }
  const total = clampCount(usage.cache_creation_input_tokens ?? 0);
  return getCacheTtl() === '1h'
    ? { ephemeral5m: 0, ephemeral1h: total }
    : { ephemeral5m: total, ephemeral1h: 0 };
}

/**
 * Normalize one Anthropic call's usage while retaining provider diagnostics.
 *
 * `model` is optional — when supplied, `totalCostUsd` is computed from the
 * static pricing table. When unknown or omitted, `totalCostUsd` is left
 * undefined so callers can detect "cost unavailable" vs. "cost is zero".
 *
 * `requestSpeed` is the tier this call ASKED for; the tier the API says it
 * SERVED (`usage.speed`) is preferred for billing when present — see
 * `SpeedPricingContext`.
 */
export function toProviderUsage(
  usage: Usage | null,
  stopReason: string | null,
  model?: string,
  requestSpeed?: AnthropicSpeed,
): ProviderUsage {
  if (!usage) return { stopReason: stopReason ?? null };

  const responseSpeed = observedSpeed(usage);
  const out: ProviderUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    stopReason: stopReason ?? null,
    raw: {
      ...(usage as unknown as Record<string, unknown>),
      ...(responseSpeed ? { speed: responseSpeed } : {}),
    },
  };
  if (usage.cache_read_input_tokens != null) out.cachedInputTokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null)
    out.cacheCreationTokens = usage.cache_creation_input_tokens;
  out.totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

  if (model) {
    const cost = deriveCallCostUsd(
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      resolveCacheWriteSplit(usage),
      {
        ...(requestSpeed ? { requestSpeed } : {}),
        ...(responseSpeed ? { responseSpeed } : {}),
      },
    );
    if (cost !== undefined) out.totalCostUsd = cost;
  }
  return out;
}
