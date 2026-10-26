/**
 * Billing-normalized usage (#3878): construction, summation, and the
 * `ResponseMetadata.usage` wire keys that carry it from a provider's `done`
 * event to the session and subagent accounting rollups.
 *
 * Contract: these helpers never touch the legacy `ProviderUsage` fields.
 * `inputTokens` / `cachedInputTokens` / `cacheCreationTokens` keep their
 * mixed semantics (summed input, latest-round cache = context occupancy);
 * billing counts are summed everywhere and `uncachedInput` always excludes
 * cache reads, so `cacheRead / (uncachedInput + cacheRead + cacheWrite)` is a
 * true hit rate on every provider.
 *
 * @module agent/usage.billing
 */

import type { BillingUsage } from './provider.js';

/** Snake-case keys on `ResponseMetadata.usage` (alongside `input_tokens` etc.). */
export const BILLING_USAGE_KEYS = {
  provider: 'billing_provider',
  uncachedInput: 'billing_uncached_input_tokens',
  cacheRead: 'billing_cache_read_tokens',
  cacheWrite: 'billing_cache_write_tokens',
  output: 'billing_output_tokens',
} as const;

const nonNeg = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * Anthropic semantics: `input_tokens` already EXCLUDES cache reads and cache
 * writes, so each counter maps directly.
 */
export function anthropicBilling(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): BillingUsage {
  return {
    provider: 'anthropic-direct',
    uncachedInput: nonNeg(u.input_tokens),
    cacheRead: nonNeg(u.cache_read_input_tokens),
    cacheWrite: nonNeg(u.cache_creation_input_tokens),
    output: nonNeg(u.output_tokens),
  };
}

/**
 * OpenAI semantics: `prompt_tokens` INCLUDES `cached_tokens` (a subset), so the
 * uncached share is the difference — subtracted exactly once, here. Clamped at
 * zero against a backend that reports `cached > prompt`. No cache-write charge
 * exists on this API, so `cacheWrite` is always 0.
 */
export function openAICompatibleBilling(
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): BillingUsage {
  const prompt = nonNeg(promptTokens);
  const cached = Math.min(nonNeg(cachedTokens), prompt);
  return {
    provider: 'openai-compatible',
    uncachedInput: prompt - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: nonNeg(completionTokens),
  };
}

/**
 * Sum two billing records. Counters add; `provider` carries forward when both
 * sides agree (the normal case: a single provider serves every round of a
 * turn). Either side may be absent.
 *
 * If `a.provider !== b.provider` the records cannot be attributed to a single
 * provider. A warning is emitted so the unexpected path is visible, and the
 * result is tagged `'mixed'` so the caller's per-provider cache-hit metrics
 * are not silently skewed toward the last record's provider.
 */
export function sumBillingUsage(
  a: BillingUsage | undefined,
  b: BillingUsage | undefined,
): BillingUsage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  // Short-circuit: if either input is already 'mixed', propagate without
  // re-warning.  A 'mixed' record can arise at construction time (mismatched
  // providers in a single call) or via `billingFromUsageRecord` deserialization
  // (a stored sidecar that was already mixed). Either way, warning again on
  // every subsequent accumulation would flood the log with redundant noise.
  let provider: string;
  if (a.provider === 'mixed' || b.provider === 'mixed') {
    provider = 'mixed';
  } else if (a.provider !== b.provider) {
    // eslint-disable-next-line no-console
    console.warn(
      `[billing] sumBillingUsage: provider mismatch (${a.provider} vs ${b.provider}). ` +
        `Tagging result as 'mixed'. Child sessions should use a single provider per run.`,
    );
    provider = 'mixed';
  } else {
    provider = b.provider;
  }
  return {
    provider,
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** Flatten a billing record onto `ResponseMetadata.usage` keys. */
export function billingToUsageFields(b: BillingUsage | undefined): Record<string, unknown> {
  if (!b) return {};
  return {
    [BILLING_USAGE_KEYS.provider]: b.provider,
    [BILLING_USAGE_KEYS.uncachedInput]: b.uncachedInput,
    [BILLING_USAGE_KEYS.cacheRead]: b.cacheRead,
    [BILLING_USAGE_KEYS.cacheWrite]: b.cacheWrite,
    [BILLING_USAGE_KEYS.output]: b.output,
  };
}

/**
 * Read a billing record back off a `ResponseMetadata.usage` object. Returns
 * undefined unless the provider tag is present (i.e. the producer populated
 * billing), so legacy usage objects never fabricate zero billing.
 */
export function billingFromUsageRecord(u: Record<string, unknown> | undefined): BillingUsage | undefined {
  if (!u) return undefined;
  const provider = u[BILLING_USAGE_KEYS.provider];
  if (typeof provider !== 'string' || provider.length === 0) return undefined;
  const num = (key: string): number => {
    const v = u[key];
    return typeof v === 'number' ? nonNeg(v) : 0;
  };
  return {
    provider,
    uncachedInput: num(BILLING_USAGE_KEYS.uncachedInput),
    cacheRead: num(BILLING_USAGE_KEYS.cacheRead),
    cacheWrite: num(BILLING_USAGE_KEYS.cacheWrite),
    output: num(BILLING_USAGE_KEYS.output),
  };
}

/**
 * `subagent_lifecycle.succeeded` fields for a child's summed billing:
 * `{ provider, tokens }`, or `{}` when the provider reported no usage.
 */
export function billingLifecycleFields(b: BillingUsage | undefined): {
  provider?: string;
  tokens?: { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number };
} {
  if (!b) return {};
  const { provider, ...tokens } = b;
  return { provider, tokens };
}
