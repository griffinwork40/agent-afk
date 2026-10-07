/**
 * Connection-phase helper for {@link driveStream}.
 *
 * Extracted from stream-drive.ts to bring {@link driveStream} under the 200-line
 * function ceiling. Encapsulates the inner `for` loop that retries `createStream`
 * on transient HTTP errors, returning either the opened stream or an error
 * object the caller can inspect.
 *
 * All parameters are explicit — no closure over outer locals.
 *
 * @module agent/providers/openai-compatible/query/stream-drive.connection
 */

import type { TraceSink } from '../../../trace/index.js';
import {
  MAX_CONNECTION_RETRIES,
  computeBackoffDelay,
  isRetryableConnectionError,
  retryAfterDelayMs,
} from './retry.js';
import { emitAndSleepRetry } from './stream-drive.retry.js';
import { isConnectionTimeoutError, isConnectionPhaseNetworkError, isRetryableConnectionStatus } from '../../shared/connection-error.js';
import { ConnectionRetryBudget, connectionFailureMetadata } from '../../shared/connection-retry-budget.js';
import { emitSessionPhase } from '../../../trace/emit.js';

/** Outcome returned by {@link runConnectionPhase}. */
export type ConnectionOutcome<TEvent> =
  | { ok: true; stream: AsyncIterable<TEvent> }
  | { ok: false; error: unknown };

/**
 * Attempt to open a streaming connection, retrying on transient HTTP errors.
 *
 * @param createStream  - Wire-specific stream opener (throws on failure).
 * @param streamSignal  - The combined turn+watchdog signal to pass to `createStream`.
 * @param userSignal    - The turn-level user abort signal (distinct from watchdog aborts).
 * @param traceWriter   - Session trace sink.
 * @param resolvedModel - Current model name for trace events.
 * @returns A {@link ConnectionOutcome}: either the open stream or the last error.
 *   Returns `{ ok: false, error: 'aborted' }` (a sentinel string) when the
 *   user signal fired during a retry sleep — the caller must `return null`.
 */
export async function runConnectionPhase<TEvent>(
  createStream: (signal: AbortSignal) => Promise<AsyncIterable<TEvent>>,
  streamSignal: AbortSignal,
  userSignal: AbortSignal,
  traceWriter: TraceSink | undefined,
  resolvedModel: string,
  endpoint?: string,
): Promise<ConnectionOutcome<TEvent>> {
  const budget = new ConnectionRetryBudget();
  const trace = (phase: 'connection_failure' | 'connection_recovered' | 'connection_budget_exhausted', metadata: Record<string, string | number | boolean>): void => {
    void emitSessionPhase(traceWriter, { phase, resolvedModel, metadata });
  };
  let networkAttempts = 0;
  let overloadAttempts = 0;
  for (;;) {
    try {
      // Invariant: turn-driver dispatches tools only after driveStream returns a
      // completed iteration. A failed opener has no tool effects to duplicate.
      const stream = await createStream(streamSignal);
      if (networkAttempts) trace('connection_recovered', { attempts: networkAttempts + 1, outageMs: budget.elapsedMs() });
      return { ok: true, stream };
    } catch (err) {
      // A watchdog abort during connection is NOT a user interrupt. Check the
      // userSignal explicitly so TTFB/stall timeouts are not swallowed.
      if (userSignal.aborted) return { ok: false, error: 'aborted' };
      // An `APIConnectionTimeoutError` while `streamSignal` is NOT aborted is the
      // SDK's own connect timeout (an AFK watchdog abort surfaces as
      // APIUserAbortError), so it is a transient blip, not the TTFB window.
      // See isConnectionTimeoutError. Kept out of isRetryableConnectionError
      // because that predicate has no signal to gate on.
      const sdkTimeout = isConnectionTimeoutError(err) && !streamSignal.aborted;
      const retryable = sdkTimeout || isRetryableConnectionError(err);
      // Invariant: network errors (DNS, socket, connection-phase status codes)
      // and non-network retryable errors (429 rate-limit, 503 overload) use
      // independent attempt counters so exhausting one budget does not starve
      // the other. Mirrors anthropic-direct's connectionAttempts/overloadAttempts.
      const network = sdkTimeout || isConnectionPhaseNetworkError(err) || isRetryableConnectionStatus(err);
      if (network && !streamSignal.aborted) trace('connection_failure', connectionFailureMetadata(err, budget, endpoint));
      const attempt = network ? networkAttempts : overloadAttempts;
      const allowed = network ? budget.canRetry(attempt, MAX_CONNECTION_RETRIES) : attempt < MAX_CONNECTION_RETRIES;
      if (retryable && (budget.budgetMs === undefined || !streamSignal.aborted) && allowed) {
        if (network) networkAttempts++; else overloadAttempts++;
        const hinted = retryAfterDelayMs(err);
        const legacyDelay = hinted ?? computeBackoffDelay(attempt);
        const delay = network ? budget.delay(legacyDelay, 2_000, attempt) : legacyDelay;
        // Item 2: sleep on streamSignal so the TTFB watchdog can abort a long
        // retry-after sleep and trigger the retryable TTFB path. Check the user
        // signal after the sleep to distinguish watchdog abort from user interrupt.
        const userAborted = await emitAndSleepRetry(
          traceWriter,
          resolvedModel,
          delay,
          streamSignal,
          userSignal,
          {
            source: 'connection',
            reason: hinted !== undefined ? 'retry-after' : 'backoff',
            attempt,
          },
        );
        if (userAborted) return { ok: false, error: 'aborted' };
        if (budget.budgetMs !== undefined && streamSignal.aborted) return { ok: false, error: err };
        if (network && budget.budgetMs !== undefined && !budget.canRetry(networkAttempts, MAX_CONNECTION_RETRIES)) {
          trace('connection_budget_exhausted', connectionFailureMetadata(err, budget, endpoint));
          return { ok: false, error: err };
        }
        continue;
      }
      if (network && !streamSignal.aborted) trace('connection_budget_exhausted', connectionFailureMetadata(err, budget, endpoint));
      return { ok: false, error: err };
    }
  }
}
