/**
 * Usage-limit detection and wait logic for the Anthropic-direct provider.
 *
 * Classifies HTTP 429 (OAuth subscription exhausted) and HTTP 400 + "credit
 * balance" (API-key exhausted) errors, and provides a `waitForReset` helper
 * that sleeps until the subscription rolls over (or the caller aborts).
 *
 * The hot-swap path watches the Claude Code keychain token byte-equality every
 * 30 s — if the operator logs into a different Claude account in another
 * terminal, the token changes and `waitForReset` wakes immediately with
 * `'hot-swap'`, so the caller can re-read the fresh token and retry.
 *
 * @module agent/providers/anthropic-direct/usage-limit
 */

import { loadClaudeCodeOauthToken } from '../../auth/keychain.js';

export type UsageLimitClassification =
  | { kind: 'oauth-limit'; resetsAt: Date }
  | { kind: 'oauth-limit-no-ts' }
  | { kind: 'rate-limit-transient'; retryAfterMs?: number }
  | { kind: 'credit-exhausted' };

/**
 * Upper bound (ms) on a `retry-after` hint that still counts as a *transient*
 * API-tier rate limit (per-minute RPM/ITPM/OTPM windows that clear in seconds).
 *
 * Invariant: this magnitude heuristic is now a LAST-RESORT fallback, used only
 * when a 429 carries NO `anthropic-ratelimit-*` headers at all (see
 * {@link classifyUsageLimitError}). When those authoritative headers are
 * present the classifier keys on them directly, mirroring Claude Code. But
 * Anthropic can still deliver an OAuth *subscription* cap as a bare
 * `rate_limit_error` with a `retry-after` header and no `|<ts>` and no rate-
 * limit headers (anthropics/claude-code#30930); in that header-less case
 * PRESENCE cannot distinguish a throttle from a subscription cap, so MAGNITUDE
 * is the only remaining signal. Per-minute throttles clear in ≤ a minute or
 * two; a subscription reset is hours away, so a `retry-after` above this line
 * is treated as subscription exhaustion (pause + hot-swap + auto-resume), not a
 * short silent retry.
 */
export const RATE_LIMIT_TRANSIENT_MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Defensive read of a single HTTP header off an error's `headers` field.
 *
 * The Anthropic SDK's `APIError.headers` has been both a web `Headers` (with
 * `.get`) and a plain record across versions, so both shapes are handled:
 * a `.get()` method is preferred, else the record is probed for the exact key
 * and its upper-cased form. Returns the header value, or `undefined` when the
 * error is not an object, has no usable `headers`, or the header is absent.
 *
 * Shared by {@link parseRetryAfterMs} and {@link classifyUsageLimitError}'s
 * unified/per-minute header reads so all header access uses one code path.
 */
export function getHeader(error: unknown, name: string): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return undefined;
  const h = headers as { get?: unknown };
  if (typeof h.get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  if (typeof headers === 'object') {
    const rec = headers as Record<string, unknown>;
    const v = rec[name] ?? rec[name.toUpperCase()];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Best-effort parse of a transient-backoff hint from an error's HTTP headers.
 *
 * Reads `retry-after-ms` (milliseconds) first, then `retry-after` (seconds, or
 * an HTTP-date). Returns the delay in ms, or `undefined` when no usable header
 * is present. Header access is via the shared {@link getHeader} helper, which
 * handles both a web `Headers` (with `.get`) and a plain-record shape.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  const ms = getHeader(error, 'retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const sec = getHeader(error, 'retry-after');
  if (sec !== undefined) {
    const n = Number(sec);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    const dateMs = Date.parse(sec);
    if (!Number.isNaN(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta >= 0) return delta;
    }
  }
  return undefined;
}

/**
 * Classify an error as a usage-limit error, or return `null` if it is not one.
 *
 * Invariant: a 429's classification precedence keys on AUTHORITATIVE signals
 * first and demotes the `retry-after` MAGNITUDE heuristic to a last-resort
 * fallback — mirroring Claude Code (verified against v2.1.206), which decides
 * subscription-cap vs. transient by the presence of `anthropic-ratelimit-
 * unified-*` headers, never by `retry-after` size. The change is strictly
 * ADDITIVE and PRESENCE-GATED: when NONE of the `anthropic-ratelimit-*` headers
 * are present the result is byte-for-byte identical to the pre-existing
 * fallback (step 4), so there is no behavior change on real 429s that don't
 * carry the headers. In precedence order for `status === 429`:
 *   1. Message contains `|<unix-ts>` — OAuth subscription limit; the timestamp
 *      is the reset. Authoritative when present, so checked first.
 *   2. Unified subscription headers present (`unified-representative-claim` OR
 *      `unified-overage-status` present, OR `unified-status === "rejected"`) —
 *      a subscription cap. If `unified-reset` is present and a finite positive
 *      number, return `oauth-limit` with `resetsAt = reset * 1000` (the header
 *      is epoch SECONDS — an authoritative deadline that upgrades the blind
 *      poll to a real wait); else `oauth-limit-no-ts`.
 *   3. Per-minute throttle headers present (`anthropic-ratelimit-{requests,
 *      input-tokens,output-tokens}-*`, e.g. `-remaining`) — a transient API-
 *      tier rate limit that clears in seconds → `rate-limit-transient` with
 *      `retryAfterMs` from {@link parseRetryAfterMs}.
 *   4. No rate-limit headers at all — FALLBACK to the magnitude heuristic: a
 *      short `retry-after` (≤ {@link RATE_LIMIT_TRANSIENT_MAX_RETRY_AFTER_MS})
 *      is a per-minute throttle → `rate-limit-transient`; a long or absent
 *      backoff is subscription-scale → `oauth-limit-no-ts` (pause + hot-swap +
 *      auto-resume). Anthropic can deliver a subscription cap as a bare
 *      `rate_limit_error` + `retry-after` with no headers
 *      (anthropics/claude-code#30930), so magnitude is the only remaining
 *      signal here.
 *
 * Also recognised:
 *   - HTTP 400 + `invalid_request_error` + `credit balance` — API key balance
 *     exhausted.
 */
export function classifyUsageLimitError(error: Error): UsageLimitClassification | null {
  if (!('status' in error)) return null;
  const status = (error as Error & { status: number }).status;

  if (status === 429) {
    // Step 1: `|<unix-ts>` message parse — authoritative when present.
    const parts = error.message.split('|');
    if (parts.length >= 2) {
      const ts = parseInt(parts[1]!.trim(), 10);
      if (!isNaN(ts) && ts > 0) {
        return { kind: 'oauth-limit', resetsAt: new Date(ts * 1000) };
      }
    }

    // Step 2: unified subscription headers — the signal Claude Code keys on.
    // Presence of a representative-claim / overage-status header, or an
    // explicit rejected status, marks this 429 as a subscription cap.
    const unifiedClaim = getHeader(error, 'anthropic-ratelimit-unified-representative-claim');
    const unifiedOverage = getHeader(error, 'anthropic-ratelimit-unified-overage-status');
    const unifiedStatus = getHeader(error, 'anthropic-ratelimit-unified-status');
    if (
      unifiedClaim !== undefined ||
      unifiedOverage !== undefined ||
      unifiedStatus === 'rejected'
    ) {
      const reset = getHeader(error, 'anthropic-ratelimit-unified-reset');
      if (reset !== undefined) {
        const resetSec = Number(reset);
        if (Number.isFinite(resetSec) && resetSec > 0) {
          // Header is epoch SECONDS; the authoritative reset deadline.
          return { kind: 'oauth-limit', resetsAt: new Date(resetSec * 1000) };
        }
      }
      return { kind: 'oauth-limit-no-ts' };
    }

    // Step 3: per-minute throttle headers — RPM/ITPM/OTPM windows that clear in
    // seconds. Their presence (any of the requests/token counters) means this
    // is a transient API-tier rate limit, distinct from a subscription cap.
    const perMinutePresent =
      getHeader(error, 'anthropic-ratelimit-requests-remaining') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-requests-limit') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-requests-reset') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-input-tokens-remaining') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-input-tokens-limit') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-input-tokens-reset') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-output-tokens-remaining') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-output-tokens-limit') !== undefined ||
      getHeader(error, 'anthropic-ratelimit-output-tokens-reset') !== undefined;
    if (perMinutePresent) {
      return { kind: 'rate-limit-transient', retryAfterMs: parseRetryAfterMs(error) };
    }

    // Step 4: FALLBACK — no `anthropic-ratelimit-*` headers at all. Preserve the
    // pre-existing magnitude heuristic byte-for-byte so this path is unchanged
    // for real 429s that carry no rate-limit headers.
    //
    // Invariant: Anthropic returns the SAME `429 rate_limit_error` + `retry-after`
    // shape for a per-minute API throttle AND an OAuth subscription cap — the
    // subscription limit arrives as a bare `rate_limit_error` with a `retry-after`
    // header and no `|<ts>` (anthropics/claude-code#30930). With no rate-limit
    // headers present, PRESENCE cannot tell them apart; only MAGNITUDE can. A
    // short backoff (≤ threshold) is a per-minute throttle → transient short
    // retry. A long or absent backoff is subscription-scale → oauth-limit-no-ts
    // (pause + hot-swap + auto-resume), so the operator is notified and an
    // account hot-swap resumes the turn. Treating EVERY retry-after 429 as
    // transient silently lost both the pause notification and the hot-swap
    // watcher — the regression this magnitude gate fixes.
    const retryAfterMs = parseRetryAfterMs(error);
    if (
      retryAfterMs !== undefined &&
      retryAfterMs <= RATE_LIMIT_TRANSIENT_MAX_RETRY_AFTER_MS
    ) {
      return { kind: 'rate-limit-transient', retryAfterMs };
    }
    return { kind: 'oauth-limit-no-ts' };
  }

  if (
    status === 400 &&
    error.message.includes('invalid_request_error') &&
    error.message.includes('credit balance')
  ) {
    return { kind: 'credit-exhausted' };
  }

  return null;
}

export interface WaitForResetOpts {
  resetsAt: Date;
  signal: AbortSignal;
  /** Override token reader for testing (defaults to `loadClaudeCodeOauthToken`). */
  readToken?: () => string | undefined;
}

/**
 * Sleep until the subscription reset deadline passes or an abort/hot-swap fires.
 *
 * Resolution:
 *   - `'aborted'` — caller's `signal` was aborted.
 *   - `'timer'`   — the reset deadline (`resetsAt + 30s buffer`) has passed.
 *   - `'hot-swap'` — the keychain token byte-changed (operator logged into a
 *                    different account mid-wait).
 *
 * Poll interval is 30 s.
 */
export async function waitForReset(opts: WaitForResetOpts): Promise<'aborted' | 'timer' | 'hot-swap'> {
  const { resetsAt, signal, readToken = loadClaudeCodeOauthToken } = opts;
  const initialToken = readToken();
  // NOTE: 30-second buffer past the reset timestamp to let the API actually
  // commit the reset before we retry (the Anthropic backend can lag by a few
  // seconds past the nominal reset time).
  const deadline = resetsAt.getTime() + 30_000;

  return new Promise<'aborted' | 'timer' | 'hot-swap'>((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    const settle = (result: 'aborted' | 'timer' | 'hot-swap'): void => {
      if (settled) return;
      settled = true;
      if (interval !== undefined) clearInterval(interval);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => { settle('aborted'); };
    const check = (): boolean => {
      if (signal.aborted) { settle('aborted'); return true; }
      if (Date.now() >= deadline) { settle('timer'); return true; }
      const current = readToken();
      // NOTE: comparing the full access token byte-equality is the hot-swap
      // signal. When both initial and current are undefined, the check is
      // false (correct — no swap happened). When initialToken is undefined and
      // a new token appears, we detect it as a hot-swap.
      if (current !== initialToken) { settle('hot-swap'); return true; }
      return false;
    };
    if (check()) return;
    interval = setInterval(() => { check(); }, 30_000);
    // R5: .unref() so this timer does not hold the Node process open when a
    // SIGTERM arrives during a 429 retry window. External constraint: unref'd
    // timers are skipped by Node's event-loop keep-alive check — the process
    // can exit cleanly without waiting for the full 30-second poll cycle.
    interval.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WaitForHotSwapOpts {
  signal: AbortSignal;
  /** Override token reader for testing (defaults to `loadClaudeCodeOauthToken`). */
  readToken?: () => string | undefined;
  /**
   * Optional retry deadline. When set, the wait ALSO resolves `'timer'` once
   * this many milliseconds have elapsed. A caller handling a 429 that carried
   * no reset timestamp uses this to periodically replay the turn and probe
   * whether the limit has lifted — there is no authoritative deadline to wait
   * on, so polling is the only way to auto-resume on a same-account reset.
   *
   * When omitted, the only exits are `'aborted'` and `'hot-swap'` (legacy
   * behavior — nothing to time-wait on).
   */
  retryAfterMs?: number;
}

/**
 * Wait for a keychain token hot-swap (and, optionally, a retry deadline) when
 * no reset timestamp is available (the `oauth-limit-no-ts` case — API returned
 * 429 without a `|<unix-ts>` segment).
 *
 * Exit conditions:
 *   - `'aborted'`  — caller's `signal` was aborted.
 *   - `'hot-swap'` — keychain token byte-changed (operator logged into a
 *                    different Claude account mid-wait).
 *   - `'timer'`    — only when `retryAfterMs` is provided: that interval has
 *                    elapsed, so the caller should replay the turn to probe
 *                    whether a timestamp-less limit has lifted.
 *
 * The caller should display a message instructing the user to wait (auto-resume
 * will retry) or log in with a different account before calling this.
 *
 * Poll interval is 30 s (token byte-equality + deadline check).
 */
export async function waitForHotSwap(
  opts: WaitForHotSwapOpts,
): Promise<'aborted' | 'hot-swap' | 'timer'> {
  const { signal, readToken = loadClaudeCodeOauthToken, retryAfterMs } = opts;
  const initialToken = readToken();
  const deadline = retryAfterMs !== undefined ? Date.now() + retryAfterMs : undefined;

  return new Promise<'aborted' | 'hot-swap' | 'timer'>((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    const settle = (result: 'aborted' | 'hot-swap' | 'timer'): void => {
      if (settled) return;
      settled = true;
      if (interval !== undefined) clearInterval(interval);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => { settle('aborted'); };
    const check = (): boolean => {
      if (signal.aborted) { settle('aborted'); return true; }
      const current = readToken();
      if (current !== initialToken) { settle('hot-swap'); return true; }
      if (deadline !== undefined && Date.now() >= deadline) { settle('timer'); return true; }
      return false;
    };
    if (check()) return;
    interval = setInterval(() => { check(); }, 30_000);
    // R5: .unref() so this timer does not hold the Node process open when a
    // SIGTERM arrives during the wait — mirrors `waitForReset` above. External
    // constraint: unref'd timers are skipped by Node's event-loop keep-alive
    // check, so the process exits cleanly without waiting out a 30 s poll cycle.
    interval.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
