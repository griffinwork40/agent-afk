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
import { isConnectionTimeoutError } from '../../shared/connection-error.js';

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
): Promise<ConnectionOutcome<TEvent>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const stream = await createStream(streamSignal);
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
      if ((sdkTimeout || isRetryableConnectionError(err)) && attempt < MAX_CONNECTION_RETRIES) {
        const hinted = retryAfterDelayMs(err);
        const delay = hinted ?? computeBackoffDelay(attempt);
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
        continue;
      }
      return { ok: false, error: err };
    }
  }
}
