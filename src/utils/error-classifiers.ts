/**
 * Surface-agnostic error classifiers.
 *
 * These predicates inspect an unknown thrown value and return whether it
 * matches a common error category (rate-limit, network). They are pure
 * string-checks against `error.message` — no dependency on any third-party
 * SDK or surface (CLI / Telegram / daemon) — so they live in the shared
 * `src/utils/` layer where the CLI error classifier and Telegram bot can
 * both reach them without crossing surface boundaries.
 *
 * For Anthropic-specific usage-limit classification (subscription quota /
 * credit exhaustion), see
 * `src/agent/providers/anthropic-direct/usage-limit.ts` — that classifier
 * inspects provider response shapes and lives next to the provider.
 *
 * @module utils/error-classifiers
 */

/**
 * Check if error is a rate-limit error (HTTP 429-shaped, or message says so).
 */
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes('rate limit') ||
    message.toLowerCase().includes('too many requests')
  );
}

/**
 * Check if error is a transport-layer network error (connection refused,
 * timeout, DNS, etc.). Heuristic — matches common substrings in error
 * messages emitted by `fetch`, `undici`, and `node:http`.
 */
export function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes('network') ||
    message.toLowerCase().includes('connect') ||
    message.toLowerCase().includes('timeout')
  );
}
