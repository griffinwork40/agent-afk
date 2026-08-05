/**
 * Tunables shared by every {@link RetryLayer} tier.
 *
 * Extracted from `retry-layer.ts` (#824 split) so the tier modules can consume
 * the thresholds without importing the orchestrator class — which would create
 * a cycle, since the class imports the tiers. Values and comments are verbatim;
 * no threshold changed in the split.
 *
 * @module agent/providers/anthropic-direct/query/retry-constants
 */

/**
 * Both the total usage-limit polling budget and the maximum reset lead time the
 * layer will wait out. Exported so surfaces that *describe* this behaviour to
 * the user (see `cli/quota-footer.ts`) can be drift-tested against the real
 * threshold instead of hardcoding a second copy of it.
 */
export const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Transient rate-limit (429 + retry-after header, no `|ts`) replay budget.
// The SDK has already auto-retried twice by the time the error surfaces here,
// but on account-level RPM/ITPM collisions (e.g. several daemon cron sessions
// firing at once) two quick retries are not enough — the correct behavior is
// to honor `retry-after` patiently and replay the turn, instead of dying in
// seconds. Bounded per turn so a persistent limit still surfaces as an error.
export const RATE_LIMIT_TRANSIENT_MAX_RETRIES = 3;
/** Cap on a single retry-after wait — a server hint beyond this surfaces the error path sooner. */
export const RATE_LIMIT_RETRY_MAX_WAIT_MS = 120_000;
/** Fallback wait when the classification carries no usable `retryAfterMs`. */
export const RATE_LIMIT_RETRY_DEFAULT_WAIT_MS = 5_000;
/** Small random jitter added to each wait so concurrent sessions de-synchronize. */
export const RATE_LIMIT_RETRY_JITTER_MS = 1_000;

// Invariant: a 429 with no reset timestamp gives no deadline to wait on, so the
// no-ts path poll-retries the turn on this fixed cadence to probe whether the
// limit has lifted (while still waking immediately on a keychain hot-swap).
// Each probe is a single cheap rejected request; the loop is bounded at
// TWO_HOURS_MS total so a never-resetting limit eventually surfaces the error.
export const NO_TS_RETRY_INTERVAL_MS = 60 * 1000;
