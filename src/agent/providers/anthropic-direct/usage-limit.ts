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
 * Best-effort parse of a transient-backoff hint from an error's HTTP headers.
 *
 * Reads `retry-after-ms` (milliseconds) first, then `retry-after` (seconds, or
 * an HTTP-date). Returns the delay in ms, or `undefined` when no usable header
 * is present. Header access is defensive: the Anthropic SDK's `APIError.headers`
 * has been both a web `Headers` (with `.get`) and a plain record across
 * versions, so both shapes are handled.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return undefined;
  const get = (name: string): string | undefined => {
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
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const sec = get('retry-after');
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
 * Recognised patterns:
 *   - HTTP 429 with message containing `|<unix-ts>` — OAuth subscription limit
 *     (the timestamp is when the limit resets).
 *   - HTTP 429 with a `retry-after`/`retry-after-ms` header and NO `|<unix-ts>`
 *     — a transient API-tier rate limit (RPM/ITPM), NOT subscription
 *     exhaustion. The header gives a short (seconds) backoff. Kept distinct so
 *     callers do not apply the 2-hour subscription-pause semantics to a
 *     throttle that clears in seconds.
 *   - HTTP 429 without timestamp AND without a retry-after header — OAuth
 *     subscription limit with unknown reset (unchanged fallback).
 *   - HTTP 400 + `invalid_request_error` + `credit balance` — API key balance
 *     exhausted.
 */
export function classifyUsageLimitError(error: Error): UsageLimitClassification | null {
  if (!('status' in error)) return null;
  const status = (error as Error & { status: number }).status;

  if (status === 429) {
    const parts = error.message.split('|');
    if (parts.length >= 2) {
      const ts = parseInt(parts[1]!.trim(), 10);
      if (!isNaN(ts) && ts > 0) {
        return { kind: 'oauth-limit', resetsAt: new Date(ts * 1000) };
      }
    }
    // Invariant: OAuth *subscription* exhaustion encodes its reset in the
    // message `|<unix-ts>` (handled above) — it does not depend on a
    // `retry-after` header. A standard API-tier rate-limit 429 instead carries
    // `retry-after` and no timestamp. So "429 + retry-after + no |ts" is a
    // transient rate limit, and misrouting it into the timestamp-less
    // subscription path (poll every 60s for up to 2h, labelled "usage limit")
    // is the bug this branch fixes.
    const retryAfterMs = parseRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
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
