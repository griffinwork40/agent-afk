/**
 * Poll loop for the `wait_for` tool.
 *
 * Calls a condition evaluator repeatedly until the condition is met, the
 * timeout elapses, or the AbortSignal fires. Uses `sleepWithAbort` between
 * polls so the loop participates cleanly in session teardown.
 *
 * @module agent/tools/handlers/wait-for-poller
 */

import { sleepWithAbort } from '../../providers/shared/sleep-with-abort.js';
import type { WaitResult } from './wait-for-conditions.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const MIN_POLL_INTERVAL_MS = 1_000;

/** Heartbeat log interval — one debug log line every 60 s of waiting. */


export interface PollOptions {
  /** Maximum time to wait before returning `timed_out`. Default 120 000 ms. */
  timeout_ms: number;
  /** Base delay between polls. Default 5 000 ms. Min 1 000 ms. */
  poll_interval_ms: number;
  /** Backoff strategy applied to `poll_interval_ms` after each miss. */
  backoff: 'none' | 'linear' | 'exponential';
  /** Cancellation signal (session shutdown, parent abort, etc.). */
  signal: AbortSignal;
}

export interface PollResult {
  status: 'succeeded' | 'timed_out' | 'cancelled' | 'failed';
  elapsed_ms: number;
  attempts: number;
  result?: WaitResult;
  error?: string;
}

/**
 * Compute the next sleep duration given the current attempt count.
 *
 * - `none`:        always `base`
 * - `linear`:      `base + attempt * 1000` (uncapped)
 * - `exponential`: `base * 2^attempt`, capped at 60 000 ms
 */
function nextInterval(
  base: number,
  attempt: number,
  backoff: PollOptions['backoff'],
): number {
  switch (backoff) {
    case 'linear':
      return base + attempt * 1_000;
    case 'exponential':
      return Math.min(base * Math.pow(2, attempt), 60_000);
    default:
      return base;
  }
}

/**
 * Poll `evaluate` until it returns `{ met: true }`, the timeout is reached,
 * or the signal is aborted.
 *
 * The evaluator receives a per-poll AbortSignal that fires at the earlier of
 * (a) the session-level signal or (b) the remaining time to the overall
 * deadline, so a hung evaluator (e.g. a server that accepts the TCP connection
 * but never sends a response) cannot block the loop past the deadline.
 *
 * The function NEVER throws — all outcomes are expressed in the returned
 * `PollResult.status`. Callers should surface `failed` as an error only.
 */
export async function pollUntil(
  evaluate: (signal: AbortSignal) => Promise<WaitResult>,
  options: PollOptions,
): Promise<PollResult> {
  const { timeout_ms, poll_interval_ms, backoff, signal } = options;
  const deadline = Date.now() + timeout_ms;
  let attempts = 0;
  let lastResult: WaitResult | undefined;


  while (true) {
    // Check abort first (covers the case where signal was pre-aborted).
    if (signal.aborted) {
      return { status: 'cancelled', elapsed_ms: Date.now() - (deadline - timeout_ms), attempts };
    }

    // Evaluate condition with a per-poll deadline signal so a stalled
    // evaluator (e.g. a server that accepts connections but never responds)
    // is aborted no later than the remaining time to the overall deadline.
    // AbortSignal.any races the session signal against the per-poll timeout.
    const remaining = deadline - Date.now();
    const perPollSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(poll_interval_ms, remaining))),
    ]);
    let result: WaitResult;
    try {
      result = await evaluate(perPollSignal);
    } catch (err) {
      // Session-level abort takes priority — surface as cancelled.
      if (signal.aborted) {
        return { status: 'cancelled', elapsed_ms: Date.now() - (deadline - timeout_ms), attempts };
      }
      // H-3: Per-poll timeout (AbortSignal.timeout on perPollSignal) throws an
      // AbortError. This means the evaluator was slow for ONE poll interval but
      // the session is still live. Treat it as a missed poll and continue the
      // loop rather than permanently failing — a slow-but-reachable server that
      // responds in slightly more than poll_interval_ms should not kill the whole
      // wait. Check the deadline first so a missed poll at expiry still surfaces
      // as timed_out rather than silently looping forever.
      if (err instanceof Error && err.name === 'AbortError') {
        if (Date.now() >= deadline) {
          return {
            status: 'timed_out',
            elapsed_ms: Date.now() - (deadline - timeout_ms),
            attempts,
            result: lastResult,
          };
        }
        // Missed poll — continue to next attempt without incrementing the
        // success-attempt counter or advancing backoff (the evaluator never
        // returned a result this round).
        continue;
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        elapsed_ms: Date.now() - (deadline - timeout_ms),
        attempts,
        error,
      };
    }
    lastResult = result;
    attempts++;

    if (result.met) {
      return {
        status: 'succeeded',
        elapsed_ms: Date.now() - (deadline - timeout_ms),
        attempts,
        result,
      };
    }

    // Check timeout before sleeping again.
    const now = Date.now();
    if (now >= deadline) {
      return {
        // L-1: Report actual elapsed time instead of the requested timeout_ms
        // so callers see how long the loop actually ran (may be slightly more
        // than timeout_ms due to evaluator overhead).
        status: 'timed_out',
        elapsed_ms: now - (deadline - timeout_ms),
        attempts,
        result: lastResult,
      };
    }

    // Sleep, capped to remaining time.
    const sleepMs = Math.min(
      nextInterval(poll_interval_ms, attempts - 1, backoff),
      deadline - now,
    );
    await sleepWithAbort(sleepMs, signal);
  }
}
