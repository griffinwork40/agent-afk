/**
 * Stream-phase error-classification helper for {@link driveStream}.
 *
 * Extracted from stream-drive.ts to bring {@link driveStream} under the 200-line
 * function ceiling. Classifies a mid-stream error and returns a discriminated
 * action value; the caller (an async generator) performs any `yield` and
 * `continue`/`return` so the generator context stays in the outer function.
 *
 * All parameters are explicit — no closure over outer locals.
 *
 * @module agent/providers/openai-compatible/query/stream-drive.stream-error
 */

import {
  isTtfbTimeoutError,
} from '../../shared/first-byte-timeout.js';
import {
  isStallTimeoutError,
  stallTimeoutError,
} from '../../shared/stream-stall-timeout.js';
import {
  MAX_STREAM_RETRIES,
  computeBackoffDelay,
  isRetryableStreamError,
  retryAfterDelayMs,
} from './retry.js';

/** The outer generator must yield `stream.retry` then call `emitAndSleepRetry`. */
export interface RetryAction {
  kind: 'retry';
  delay: number;
  source: 'stream';
  reason: 'stall_timeout' | 'ttfb_timeout' | 'retry-after' | 'backoff';
  attempt: number;
}

/** The outer generator must yield an `error` event and return null. */
export interface FatalAction {
  kind: 'fatal';
  error: Error;
}

/** The caller already checked `userSignal.aborted`; this covers non-user aborts. */
export interface FallThroughAction {
  kind: 'fall-through';
  error: unknown;
}

export type StreamErrorAction = RetryAction | FatalAction | FallThroughAction;

/**
 * Classify a mid-stream error and return the action the caller must perform.
 *
 * @param err                      - The error thrown by the stream iterator.
 * @param contentYieldedThisAttempt - Whether any translated events were yielded.
 * @param streamRetries            - Current retry count (will be incremented inside).
 * @param stallMs                  - The stall timeout in ms (for the error message).
 * @returns A {@link StreamErrorAction} describing what the caller must do, and
 *   the updated `streamRetries` count (already incremented for retry actions).
 */
export function classifyStreamError(
  err: unknown,
  contentYieldedThisAttempt: boolean,
  streamRetries: number,
  stallMs: number,
): { action: StreamErrorAction; newStreamRetries: number } {
  if (isStallTimeoutError(err)) {
    if (!contentYieldedThisAttempt && streamRetries < MAX_STREAM_RETRIES) {
      const next = streamRetries + 1;
      return {
        action: {
          kind: 'retry',
          delay: computeBackoffDelay(next - 1),
          source: 'stream',
          reason: 'stall_timeout',
          attempt: next,
        },
        newStreamRetries: next,
      };
    }
    return {
      action: { kind: 'fatal', error: stallTimeoutError(stallMs) },
      newStreamRetries: streamRetries,
    };
  }

  if (isTtfbTimeoutError(err) && streamRetries < MAX_STREAM_RETRIES) {
    const next = streamRetries + 1;
    return {
      action: {
        kind: 'retry',
        delay: computeBackoffDelay(next - 1),
        source: 'stream',
        reason: 'ttfb_timeout',
        attempt: next,
      },
      newStreamRetries: next,
    };
  }

  if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
    const next = streamRetries + 1;
    const hinted = retryAfterDelayMs(err);
    const delay = hinted ?? computeBackoffDelay(next - 1);
    return {
      action: {
        kind: 'retry',
        delay,
        source: 'stream',
        reason: hinted !== undefined ? 'retry-after' : 'backoff',
        attempt: next,
      },
      newStreamRetries: next,
    };
  }

  return {
    action: { kind: 'fall-through', error: err },
    newStreamRetries: streamRetries,
  };
}
