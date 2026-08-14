/**
 * Pure parsing of per-minute rate-limit headers from both the Anthropic and
 * OpenAI-compatible response formats.
 *
 * No side effects — returns a {@link RateLimitSnapshot} (or `undefined` when
 * no recognisable headers are present) so the caller decides what to do with it.
 * Designed to be inlined into the fetch-wrapper `onRateLimit` callback and
 * easily unit-tested in isolation.
 *
 * @module agent/providers/shared/rate-limit-headers
 */

import type { RateLimitSnapshot } from './rate-limit-bucket.js';

// ── Anthropic header names ────────────────────────────────────────────────────

const A_REQ_REMAINING = 'anthropic-ratelimit-requests-remaining';
const A_REQ_LIMIT = 'anthropic-ratelimit-requests-limit';
const A_REQ_RESET = 'anthropic-ratelimit-requests-reset';
const A_INPUT_REMAINING = 'anthropic-ratelimit-input-tokens-remaining';
const A_INPUT_LIMIT = 'anthropic-ratelimit-input-tokens-limit';
const A_INPUT_RESET = 'anthropic-ratelimit-input-tokens-reset';
const A_OUTPUT_REMAINING = 'anthropic-ratelimit-output-tokens-remaining';
const A_OUTPUT_RESET = 'anthropic-ratelimit-output-tokens-reset';

// ── OpenAI header names ───────────────────────────────────────────────────────

const O_REQ_REMAINING = 'x-ratelimit-remaining-requests';
const O_REQ_LIMIT = 'x-ratelimit-limit-requests';
const O_REQ_RESET = 'x-ratelimit-reset-requests';
const O_TOK_REMAINING = 'x-ratelimit-remaining-tokens';
const O_TOK_LIMIT = 'x-ratelimit-limit-tokens';
const O_TOK_RESET = 'x-ratelimit-reset-tokens';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a non-negative integer from a header string; returns undefined on failure. */
function parseCount(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Parse an ISO-8601 timestamp to epoch ms. Returns undefined if the string is
 * not a valid future-or-present timestamp.
 */
function parseIso8601(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}

/**
 * Parse OpenAI-style reset durations like "1m3s", "30s", "1h2m3s", or plain
 * ISO-8601 timestamps to epoch ms.
 *
 * @param raw   - The raw header value to parse.
 * @param now   - The epoch-ms reference time used when computing duration-based
 *                reset timestamps. Defaults to `Date.now()` but callers should
 *                pass a pinned value captured at call time for determinism.
 *
 * Returns undefined if the string cannot be parsed to a valid duration.
 */
function parseDurationOrIso(raw: string | null | undefined, now: number = Date.now()): number | undefined {
  if (raw == null || raw === '') return undefined;
  // Try ISO-8601 first (contains 'T' or '-')
  if (raw.includes('T') || raw.includes('-')) return parseIso8601(raw);
  // Duration string: e.g. "1h2m3.456s", "30s", "1m"
  let totalMs = 0;
  let matched = false;
  const hourMatch = raw.match(/(\d+)h/);
  const minMatch = raw.match(/(\d+)m(?!s)/); // avoid matching "ms" suffix
  const secMatch = raw.match(/(\d+(?:\.\d+)?)s/);
  if (hourMatch) { totalMs += parseInt(hourMatch[1]!, 10) * 3_600_000; matched = true; }
  if (minMatch) { totalMs += parseInt(minMatch[1]!, 10) * 60_000; matched = true; }
  if (secMatch) { totalMs += parseFloat(secMatch[1]!) * 1_000; matched = true; }
  if (!matched) return undefined;
  const resetAt = now + totalMs;
  return resetAt;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse Anthropic's per-minute `anthropic-ratelimit-*` headers from a response.
 *
 * Returns a {@link RateLimitSnapshot} when at least one recognisable header is
 * present; `undefined` when none are (e.g. OAuth subscription accounts, which
 * only emit the unified-5h/7d headers read by `quota-cache.ts`).
 */
export function parseAnthropicRateLimitHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const reqRemaining = parseCount(headers.get(A_REQ_REMAINING));
  const reqLimit = parseCount(headers.get(A_REQ_LIMIT));
  const reqResetAt = parseIso8601(headers.get(A_REQ_RESET));
  const inputRemaining = parseCount(headers.get(A_INPUT_REMAINING));
  const inputLimit = parseCount(headers.get(A_INPUT_LIMIT));
  const inputResetAt = parseIso8601(headers.get(A_INPUT_RESET));
  const outputRemaining = parseCount(headers.get(A_OUTPUT_REMAINING));
  const outputResetAt = parseIso8601(headers.get(A_OUTPUT_RESET));

  // At least one field must be present to form a meaningful snapshot.
  if (
    reqRemaining === undefined &&
    reqLimit === undefined &&
    inputRemaining === undefined &&
    outputRemaining === undefined
  ) {
    return undefined;
  }

  const snap: RateLimitSnapshot = {};
  if (reqRemaining !== undefined) snap.requestsRemaining = reqRemaining;
  if (reqLimit !== undefined) snap.requestsLimit = reqLimit;
  if (reqResetAt !== undefined) snap.requestsResetAt = reqResetAt;
  if (inputRemaining !== undefined) snap.inputTokensRemaining = inputRemaining;
  if (inputLimit !== undefined) snap.inputTokensLimit = inputLimit;
  if (inputResetAt !== undefined) snap.inputTokensResetAt = inputResetAt;
  if (outputRemaining !== undefined) snap.outputTokensRemaining = outputRemaining;
  if (outputResetAt !== undefined) snap.outputTokensResetAt = outputResetAt;
  return snap;
}

/**
 * Parse OpenAI-compatible `x-ratelimit-*` headers from a response.
 *
 * The reset headers accept either a duration string ("1m3s") or ISO-8601.
 * Token counts cover combined input+output (the OpenAI convention); they are
 * stored as `inputTokensRemaining` in the snapshot so the bucket can gate on
 * them uniformly. Returns `undefined` when none of the expected headers appear.
 */
export function parseOpenAIRateLimitHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const now = Date.now();
  const reqRemaining = parseCount(headers.get(O_REQ_REMAINING));
  const reqLimit = parseCount(headers.get(O_REQ_LIMIT));
  const reqResetAt = parseDurationOrIso(headers.get(O_REQ_RESET), now);
  const tokRemaining = parseCount(headers.get(O_TOK_REMAINING));
  const tokLimit = parseCount(headers.get(O_TOK_LIMIT));
  const tokResetAt = parseDurationOrIso(headers.get(O_TOK_RESET), now);

  if (reqRemaining === undefined && tokRemaining === undefined) return undefined;

  const snap: RateLimitSnapshot = {};
  if (reqRemaining !== undefined) snap.requestsRemaining = reqRemaining;
  if (reqLimit !== undefined) snap.requestsLimit = reqLimit;
  if (reqResetAt !== undefined) snap.requestsResetAt = reqResetAt;
  // OpenAI's token headers cover combined I/O — store as inputTokensRemaining /
  // inputTokensLimit so the bucket gates on them the same way as Anthropic's ITPM.
  if (tokRemaining !== undefined) snap.inputTokensRemaining = tokRemaining;
  if (tokLimit !== undefined) snap.inputTokensLimit = tokLimit;
  if (tokResetAt !== undefined) snap.inputTokensResetAt = tokResetAt;
  return snap;
}
