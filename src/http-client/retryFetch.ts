/**
 * Retrying fetch wrapper for the web layer (self-unsticking, autonomy MVP).
 *
 * Web fetches are idempotent GETs, so retrying transient failures — network
 * errors and HTTP 429/502/503/504 — is safe and turns a flaky upstream into a
 * recoverable one. That is the difference between an unattended run dying on a
 * single blip and one that survives it.
 *
 * Invariant: abort is terminal — a request whose signal has fired is NEVER
 * retried; the abort error propagates immediately. Honors delta-seconds or
 * HTTP-date `Retry-After` headers when present, otherwise uses
 * exponential backoff with full jitter, capped.
 *
 * Scope: deliberately NOT used by the browser ACTION layer, where actions are
 * state-changing (a retried click/fill could double-submit). Browser-action
 * retry needs idempotency-aware design and is tracked separately.
 *
 * @module web/retryFetch
 */

import type { FetchFn } from './types.js';
import { debugLog } from '../utils/debug.js';
import { extractEgressBlockedError } from '../utils/errors.js';

/** HTTP statuses worth retrying on an idempotent GET. */
const RETRYABLE_STATUS = new Set<number>([429, 502, 503, 504]);

export interface RetryFetchOptions {
  /** Max ADDITIONAL attempts (default 3; 429 defaults to only 2 retries). */
  retries?: number;
  /** Base backoff in ms; grows exponentially per attempt (default 500). */
  baseDelayMs?: number;
  /** Cap on any single backoff/Retry-After wait in ms (default 10_000). */
  maxDelayMs?: number;
  /** Injectable sleep so tests don't wait on real timers. Rejects on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter, capped at `max`. */
function backoffMs(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(base * 2 ** attempt, max);
  return Math.round(Math.random() * ceiling);
}

// Contract: preserve the Response surface; metadata follows its lifetime without
// leaking into headers or retaining completed requests.
const responseAttempts = new WeakMap<Response, number>();

export function rateLimitMessage(res: Response, url: string): string {
  const host = new URL(res.url || url).host;
  const attempts = responseAttempts.get(res) ?? 1;
  return `web_scrape HTTP 429 (rate limited by ${host}) for ${url} after ${attempts} attempts; ` +
    'do not re-request this host in parallel; wait before retrying or use a different source.';
}

/** Parse delta-seconds or HTTP-date into a non-negative, capped wait. */
function retryAfterMs(res: Response, maxDelayMs: number): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs < 0 ? null : Math.min(secs * 1000, maxDelayMs);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), maxDelayMs);
}

/**
 * Drop-in replacement for `fetchFn(url, init)` that retries transient failures.
 * Reads `init.signal` for abort (terminal). Returns the final Response, which
 * MAY be non-ok after exhausting retries — the caller decides what to do with a
 * persistent error status (escalate, surface, etc.), exactly as before.
 */
export async function retryFetch(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  opts: RetryFetchOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;
  const signal = init.signal ?? undefined;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    try {
      const res = await fetchFn(url, init);
      responseAttempts.set(res, attempt + 1);
      // Invariant: throttled parallel callers must not amplify a burst with
      // subsecond retries. Default to two retries and 5s plus jitter when
      // Retry-After is unusable. Explicit retry limits and delay caps still win.
      // Sleep observes the caller's signal, including its tool timeout budget.
      const retryLimit = res.status === 429 ? (opts.retries ?? 2) : retries;
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= retryLimit) {
        return res;
      }
      // Retryable status with attempts left: free the connection, wait, retry.
      const fallback = res.status === 429
        ? Math.min(5000 + backoffMs(attempt, baseDelayMs, maxDelayMs), maxDelayMs)
        : backoffMs(attempt, baseDelayMs, maxDelayMs);
      const wait = retryAfterMs(res, maxDelayMs) ?? fallback;
      debugLog('[web/retryFetch] retrying', { url, attempt, status: res.status, waitMs: wait });
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait, signal);
    } catch (err) {
      if (signal?.aborted) throw err; // abort is terminal — never retried
      if (extractEgressBlockedError(err) !== null) throw err; // policy block is terminal — never retried
      lastErr = err;
      if (attempt === retries) throw err; // exhausted → surface the last error
      const waitMs = backoffMs(attempt, baseDelayMs, maxDelayMs);
      debugLog('[web/retryFetch] retrying after error', { url, attempt, waitMs });
      await sleep(waitMs, signal);
    }
  }
  // Loop always returns or throws; this satisfies the type checker.
  throw lastErr ?? new Error('retryFetch: exhausted without a result');
}
