/**
 * Static pricing table + per-call cost derivation for the `anthropic-direct`
 * provider.
 *
 * Extracted from `types.ts` (which sat at ~595 LOC, well over the repo's
 * 350-line ceiling) so pricing is one concern in one file. `types.ts`
 * re-exports both symbols, so existing call sites and tests are unaffected.
 *
 * @module agent/providers/anthropic-direct/pricing
 */

/**
 * Invariant: three billing facts govern this module, all from
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
 * (verified 2026-08-05). Changing any of them changes reported dollars, so
 * they are stated once here rather than re-derived at each use site.
 *
 *  1. `input_tokens` from the Messages API counts ONLY tokens that were
 *     neither read from nor used to create a cache. It does NOT include
 *     cache reads or cache writes. Total input processed for a call is
 *     `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 *     Therefore the plain-input cost term is `input_tokens` verbatim —
 *     subtracting the cache counts off it (as this code did until 2026-08-05)
 *     double-subtracts and, because cache reads dwarf plain input in a warm
 *     session, clamps the term to zero.
 *  2. Cache WRITES are priced by TTL: 1.25× the base input rate for a 5-minute
 *     entry, but 2× for a 1-hour entry. A single flat write rate is only
 *     correct for a caller that never requests 1h — and `cache-policy.ts`
 *     defaults `AFK_PROMPT_CACHE_TTL` to `1h`, so the flat 1.25× that lived
 *     here understated the write component of every cached session by 37.5%.
 *  3. Cache READS are 0.1× the base input rate regardless of TTL.
 *
 * The API reports the write split directly on `usage.cache_creation`
 * (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), so cost is
 * derived from what was actually billed rather than inferred from local
 * config. `toProviderUsage` supplies that split; the fallback when the field
 * is absent lives there too, keeping this module pure and env-free.
 */

/** Multiplier on base input rate for a 5-minute cache write. */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
/** Multiplier on base input rate for a 1-hour cache write. */
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
/** Multiplier on base input rate for a cache read (any TTL). */
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Rates are USD per 1 million tokens.
 *
 * Sources: https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
 * (checked 2026-08-05).
 *
 * MAINTENANCE: update when Anthropic revises list prices. An unknown model
 * yields `undefined` cost (not zero) — see {@link deriveCallCostUsd}.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** 5-minute cache-write rate per MTok (default: 1.25 × input rate). */
  cacheWrite5mPerMTok?: number;
  /** 1-hour cache-write rate per MTok (default: 2 × input rate). */
  cacheWrite1hPerMTok?: number;
  /** Cache-read rate per MTok (default: 0.10 × input rate). */
  cacheReadPerMTok?: number;
}

/** @internal exported only for unit tests */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
  // Claude Sonnet 5 (GA 2026-06): standard $3 / $15 per MTok. Introductory
  // $2 / $10 pricing applies through 2026-08-31; the standard rate is used here
  // for post-intro durability of long-lived persisted cost reports.
  ['claude-sonnet-5', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  // Claude Opus 5 (GA 2026-07-24): $5 / $25 per MTok.
  ['claude-opus-5', { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10.0, cacheReadPerMTok: 0.50 }],
  // Opus 4.6/4.7/4.8 share Opus 5's $5 / $25 rates.
  ['claude-opus-4-8', { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10.0, cacheReadPerMTok: 0.50 }],
  ['claude-opus-4-7', { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10.0, cacheReadPerMTok: 0.50 }],
  ['claude-opus-4-6', { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10.0, cacheReadPerMTok: 0.50 }],
  // Claude 4.5/4.6 family (kept for backward compat with persisted sessions)
  ['claude-sonnet-4-6', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  ['claude-sonnet-4-5-20250929', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  // Opus 4.5 is $5 / $25 — NOT the $15 / $75 that lived here until 2026-08-05.
  // Those are the retired Opus 4.1/4.0 rates, copied onto the 4.5 row and
  // overstating every Opus 4.5 cost report 3×. Same copy-paste class as the
  // Haiku 3.5→4.5 mixup fixed earlier; see pricing.test.ts for the golden pin.
  ['claude-opus-4-5-20250929', { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10.0, cacheReadPerMTok: 0.50 }],
  // Haiku 4.5: $1.00 input / $5.00 output per MTok. The previous $0.80/$4.00
  // values were the Haiku 3.5 rates accidentally copied to the 4.5 row.
  ['claude-haiku-4-5-20250929', { inputPerMTok: 1.00, outputPerMTok: 5.0, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2.0, cacheReadPerMTok: 0.10 }],
  ['claude-haiku-4-5-20251001', { inputPerMTok: 1.00, outputPerMTok: 5.0, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2.0, cacheReadPerMTok: 0.10 }],
  // Claude 3.7 family (kept for backward compat with persisted sessions)
  ['claude-3-7-sonnet-20250219', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  // Claude 3.5 family
  ['claude-3-5-sonnet-20241022', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  ['claude-3-5-sonnet-20240620', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  ['claude-3-5-haiku-20241022', { inputPerMTok: 0.80, outputPerMTok: 4.0, cacheWrite5mPerMTok: 1.0, cacheWrite1hPerMTok: 1.60, cacheReadPerMTok: 0.08 }],
  // Claude 3 family
  ['claude-3-opus-20240229', { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.0, cacheReadPerMTok: 1.50 }],
  ['claude-3-sonnet-20240229', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6.0, cacheReadPerMTok: 0.30 }],
  ['claude-3-haiku-20240307', { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheWrite5mPerMTok: 0.30, cacheWrite1hPerMTok: 0.50, cacheReadPerMTok: 0.03 }],
]);

/**
 * Cache-write tokens split by the TTL they were written at. Mirrors the
 * Messages API's `usage.cache_creation` object. A call may write at both
 * TTLs in one request (the API bills 1h and 5m segments separately when
 * breakpoints mix TTLs), so this is a pair, not an enum.
 */
export interface CacheWriteSplit {
  ephemeral5m: number;
  ephemeral1h: number;
}

/**
 * Contract: returns the USD cost of ONE API call, or `undefined` when the
 * model is absent from {@link MODEL_PRICING} — callers must treat `undefined`
 * as "cost unavailable" and must not coerce it to zero.
 *
 * Pure: no env reads, no clock. `cacheWriteSplit` is supplied by the caller so
 * this stays deterministic under test; when omitted, every cache-write token
 * is priced at the 5-minute rate (the API's own default TTL). Any portion of
 * `cacheCreationTokens` not covered by `split.ephemeral5m + split.ephemeral1h`
 * (a TTL tier this module doesn't yet know about) is billed as a residual at
 * the 1h rate — see the inline Invariant comment for why.
 *
 * `inputTokens` must be the raw `usage.input_tokens` — already cache-exclusive
 * per fact 1 in the module header. Do not pre-subtract cache counts from it.
 *
 * All five numeric parameters are clamped to finite, non-negative values
 * before use — a negative or NaN wire-sourced count cannot produce a
 * negative or NaN result.
 *
 * @internal exported for unit tests
 */
export function deriveCallCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  cacheWriteSplit?: CacheWriteSplit,
): number | undefined {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return undefined;

  const M = 1_000_000;

  // Guard: every count below is wire-sourced (Messages API `usage.*` fields,
  // or a hand-built fixture in a direct test call). A negative or NaN value
  // must not produce a negative or NaN totalCostUsd. `resolveCacheWriteSplit`
  // (types.ts) clamps the split fields on the production call path, but this
  // function is also called directly (see pricing.test.ts), so it re-clamps
  // everything itself rather than trusting the caller. No import needed —
  // `Number.isFinite` is a global — so this keeps the module pure.
  const clamp = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0);
  const safeInput = clamp(inputTokens);
  const safeOutput = clamp(outputTokens);
  const safeCachedInput = clamp(cachedInputTokens);
  const safeCacheCreation = clamp(cacheCreationTokens);

  // `input_tokens` already excludes cache reads and writes — use it verbatim.
  const inputCost = (safeInput / M) * pricing.inputPerMTok;
  const outputCost = (safeOutput / M) * pricing.outputPerMTok;

  const write5mRate =
    pricing.cacheWrite5mPerMTok ?? pricing.inputPerMTok * CACHE_WRITE_5M_MULTIPLIER;
  const write1hRate =
    pricing.cacheWrite1hPerMTok ?? pricing.inputPerMTok * CACHE_WRITE_1H_MULTIPLIER;
  const readRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * CACHE_READ_MULTIPLIER;

  // Absent an explicit split, attribute all writes to the 5m rate. Callers
  // that know the request asked for 1h pass the split (see toProviderUsage).
  const split: CacheWriteSplit = cacheWriteSplit ?? {
    ephemeral5m: safeCacheCreation,
    ephemeral1h: 0,
  };
  const safe5m = clamp(split.ephemeral5m);
  const safe1h = clamp(split.ephemeral1h);

  // Invariant: `cacheCreationTokens` is the API's authoritative billed total;
  // `ephemeral5m + ephemeral1h` is only the sum of the two TTL tiers this
  // module currently knows how to price. A positive gap between them means a
  // tier this code doesn't recognize was billed (e.g. Anthropic adds a third
  // TTL the way it added 1h alongside 5m) — price the gap instead of letting
  // it default to $0. An unrecognized future tier is more likely to be a
  // longer-lived cache than a shorter one (the trend so far is 5m -> 1h), so
  // the residual bills at the 1h rate: the conservative choice, since it
  // risks overcounting a still-hypothetical short tier rather than
  // undercounting real spend.
  const residual = Math.max(0, safeCacheCreation - (safe5m + safe1h));

  const cacheWriteCost =
    (safe5m / M) * write5mRate + (safe1h / M) * write1hRate + (residual / M) * write1hRate;
  const cacheReadCost = (safeCachedInput / M) * readRate;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
