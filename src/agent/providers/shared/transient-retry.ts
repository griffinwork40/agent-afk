/**
 * Generic one-shot transient retry wrapper for model calls.
 *
 * Contract: exactly one retry layer per call, owned by the code that owns the
 * outcome. The SDK's `maxRetries` is set to 0 everywhere (PR #2702) so AFK
 * owns all retries; this module is the single authority for one-shot calls
 * (compaction summarize, background-summarizer). The streaming turn path has
 * its own budget in `retry-budget.ts` / `retry-layer.ts` and is out of scope.
 *
 * Retryable errors:
 *   - Connection-phase network errors (ECONNRESET, DNS, socket) via
 *     `isConnectionPhaseNetworkError`.
 *   - Retryable connection-phase HTTP statuses (408/500/502/504) via
 *     `isRetryableConnectionStatus` — 409 Conflict is excluded here even
 *     though the shared set includes it, because retrying a POST after a
 *     409 is semantically wrong for one-shot calls (the conflict persists).
 *   - 429 Too Many Requests (transient rate-limit with a short retry-after).
 *   - 503 Service Unavailable / 529 Overloaded.
 *
 * NOT retried:
 *   - `AbortError` / an already-aborted signal — propagated immediately.
 *   - `APIConnectionTimeoutError` — the SDK's own request timeout; AFK's TTFB
 *     watchdog owns that window (`isConnectionPhaseNetworkError` already
 *     excludes it).
 *   - 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, or any
 *     other 4xx status not in the retryable set — these are not transient.
 *   - Any error that carries a `retry-after` hint exceeding
 *     `retryAfterCeilingMs` — a long server-mandated wait (e.g. a usage-limit
 *     429) cannot be served inside a compaction budget, so we rethrow instead
 *     of blocking the caller for 60+ seconds.
 *
 * Backoff: exponential with additive jitter — `baseDelayMs * 2^attempt + jitter`.
 * When the error carries a `retry-after` hint (at most `retryAfterCeilingMs`,
 * see above), the wait is `max(hint, backoff)`.
 *
 * Abort / shouldStop: checked BEFORE and AFTER every wait. If either trips, the
 * last error is rethrown — no further attempt is started.
 *
 * @module agent/providers/shared/transient-retry
 */

import { isConnectionPhaseNetworkError, isRetryableConnectionStatus } from './connection-error.js';
import { parseRetryAfterMs } from './retry-after.js';
import { sleepWithAbort } from './sleep-with-abort.js';

/** Default retry budget (additional attempts after the first). */
export const DEFAULT_TRANSIENT_MAX_RETRIES = 2;

/** Metadata delivered to the `onRetry` callback on each retry. */
export interface RetryInfo {
  /** 1-based index of the attempt that just failed (attempt 1 = first failure). */
  attempt: number;
  /** Delay in milliseconds before the next attempt starts. */
  delayMs: number;
  /** The raw error from the failed attempt. */
  error: unknown;
  /** HTTP status from the error, when present. */
  status?: number;
  /** Network code from the error's cause chain, when present. */
  code?: string;
}

/** Options for {@link withTransientRetry}. */
export interface TransientRetryOpts {
  /** Maximum number of retry attempts (not counting the initial try). Default 2. */
  maxRetries?: number;
  /** Base backoff delay in milliseconds. Doubles per attempt, plus jitter. Default 1000. */
  baseDelayMs?: number;
  /**
   * Maximum milliseconds we will honor a `retry-after` header. When the error
   * carries a hint that EXCEEDS this ceiling, the error is rethrown immediately
   * rather than starting a long wait — a usage-limit 429 should not stall a
   * compaction pass for minutes. Default 10_000.
   */
  retryAfterCeilingMs?: number;
  /**
   * When truthy, treated as "stop now": the last error is rethrown and no
   * further attempt is started. Checked BEFORE every wait and AFTER every wait.
   * Combines with `signal.aborted`.
   */
  shouldStop?: () => boolean;
  /** Abort signal. Same semantics as `shouldStop` — also checked around waits. */
  signal?: AbortSignal;
  /**
   * Called once per retry (after the failed attempt, before the wait). Lets
   * callers route the event to the witness trace. Fire-and-forget — errors in
   * this callback are not caught.
   */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Called once when the retry budget is fully exhausted (all `maxRetries`
   * attempts have been made and the last error is about to be rethrown). Lets
   * callers emit a trace event for the terminal outcome without polling
   * `onRetry` attempt counts. Fire-and-forget — errors here are not caught.
   * Not called when the loop exits early due to abort, shouldStop, or a
   * non-transient error.
   */
  onExhausted?: (info: RetryInfo) => void;
  /**
   * Injected sleep function for tests. Defaults to `sleepWithAbort` (signal
   * propagates the abort) or plain `setTimeout` when no signal is given.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** True when the error is an AbortError (DOMException or plain Error). */
function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Contract: true when `err` should be retried by this module.
 *
 * Retryable: connection-phase network errors (ECONNRESET etc.), retryable
 * connection-phase HTTP statuses (408/500/502/504), and transient server
 * errors with statuses 429/503/529.
 *
 * NOT retryable: AbortError, APIConnectionTimeoutError (excluded by
 * `isConnectionPhaseNetworkError`), 409 Conflict (included in the shared
 * `CONNECTION_PHASE_RETRYABLE_STATUSES` for streaming turn paths but excluded
 * here — retrying a POST after a 409 is semantically wrong for one-shot calls
 * because the conflict condition persists across attempts), or any other status.
 *
 * Exported so the daemon's cron-task retry (`agent/daemon/task-retry.ts`)
 * classifies a failed run with the SAME predicate instead of a drifting copy.
 */
export function isTransientError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (isConnectionPhaseNetworkError(err)) return true;
  // Invariant: 409 Conflict is excluded from the one-shot retry path even
  // though `isRetryableConnectionStatus` (shared with streaming turn paths)
  // includes it. A POST 409 is not a transient condition — the conflict
  // persists on retry. LLM APIs do not return 409 in practice, but the
  // exclusion removes a latent semantic error.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status === 409) return false;
  if (isRetryableConnectionStatus(err)) return true;
  if (typeof status === 'number') {
    return status === 429 || status === 503 || status === 529;
  }
  return false;
}

/** Extract a numeric HTTP status from an error, when present. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === 'number' ? s : undefined;
}

/** Walk the cause chain for a network `code`, bounded to prevent infinite loops. */
function codeOf(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const { code, cause } = cur as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    if (cause === cur) return undefined;
    cur = cause;
  }
  return undefined;
}

/**
 * Run `attempt` with transient-error retries.
 *
 * Invariant: the first call to `attempt` is not counted as a retry; `maxRetries`
 * caps how many ADDITIONAL attempts are made after the first failure.
 *
 * Contract: when `opts.signal` is omitted a dummy `AbortController().signal` is
 * synthesised so `sleepWithAbort` always has a signal to race against (it
 * resolves immediately on an already-aborted signal, making this safe). The
 * dummy signal never fires, so abort propagation is silently disabled in that
 * case. All known production callers supply a real signal — if you add a new
 * caller, pass `signal` explicitly to preserve abort semantics.
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  opts: TransientRetryOpts = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_TRANSIENT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const retryAfterCeilingMs = opts.retryAfterCeilingMs ?? 10_000;
  const shouldStop = opts.shouldStop;
  const signal = opts.signal;
  // Always have a signal: a dummy one that never fires if the caller omits it.
  const effectiveSignal: AbortSignal = signal ?? new AbortController().signal;
  const sleepFn = opts.sleep ?? sleepWithAbort;

  /** True when further attempts must stop. */
  function isStopped(): boolean {
    return effectiveSignal.aborted || (shouldStop?.() ?? false);
  }

  let lastErr: unknown;

  for (let n = 0; n <= maxRetries; n++) {
    // Pre-attempt abort check.
    if (isStopped()) {
      if (lastErr !== undefined) throw lastErr;
      throw new Error('withTransientRetry: aborted before first attempt');
    }

    try {
      return await attempt();
    } catch (err) {
      lastErr = err;

      // AbortError: never retry.
      if (isAbortError(err)) throw err;

      // Already aborted: do not retry.
      if (isStopped()) throw err;

      // Not a transient error: do not retry.
      if (!isTransientError(err)) throw err;

      // Budget exhausted: notify caller and rethrow.
      if (n >= maxRetries) {
        opts.onExhausted?.({
          attempt: n + 1,
          delayMs: 0,
          error: err,
          status: statusOf(err),
          code: codeOf(err),
        });
        throw err;
      }

      // Retry-after ceiling check: if the server mandated a long wait, refuse.
      const hint = parseRetryAfterMs(err);
      if (hint !== undefined && hint > retryAfterCeilingMs) throw err;

      // Compute backoff: exponential + additive jitter (matching jitterBackoff
      // in overload-pause.ts: base * 2^n + random in [0, base * 0.25)).
      const exponential = baseDelayMs * Math.pow(2, n);
      const jitter = Math.floor(Math.random() * baseDelayMs * 0.25);
      const backoff = exponential + jitter;

      // Honor the server hint when it exceeds pure backoff.
      const delayMs = hint !== undefined ? Math.max(hint, backoff) : backoff;

      // Notify caller.
      opts.onRetry?.({
        attempt: n + 1,
        delayMs,
        error: err,
        status: statusOf(err),
        code: codeOf(err),
      });

      // Pre-wait abort check.
      if (isStopped()) throw err;

      await sleepFn(delayMs, effectiveSignal);

      // Post-wait abort check.
      // Throw an AbortError (not lastErr) so callers can distinguish a
      // stop-during-backoff from the original transient API error.
      if (isStopped()) {
        const abortErr = new Error('aborted during retry backoff');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
    }
  }

  // Unreachable — the loop always returns or throws.
  throw lastErr;
}
