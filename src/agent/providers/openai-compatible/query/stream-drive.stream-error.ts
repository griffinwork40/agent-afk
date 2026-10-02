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
import { isMidStreamNetworkTermination } from '../../shared/network-termination.js';
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
  reason: 'stall_timeout' | 'ttfb_timeout' | 'retry-after' | 'backoff' | 'network_termination';
  attempt: number;
}

/** The outer generator must yield an `error` event and return null. */
export interface FatalAction {
  kind: 'fatal';
  error: Error;
}

/**
 * A terminal event already arrived before the socket dropped — accept the
 * accumulated state as a clean completion instead of retrying or erroring.
 * The caller proceeds as if the stream ended normally.
 */
export interface AcceptAction {
  kind: 'accept';
}

/** The caller already checked `userSignal.aborted`; this covers non-user aborts. */
export interface FallThroughAction {
  kind: 'fall-through';
  error: unknown;
}

export type StreamErrorAction = RetryAction | FatalAction | AcceptAction | FallThroughAction;

/**
 * Classify a mid-stream error and return the action the caller must perform.
 *
 * Branch order (first match wins):
 *   1. Stall watchdog timed out — wins over everything else because a watchdog
 *      abort can race the transport and surface as TypeError('terminated') before
 *      the STALL_TIMEOUT_MESSAGE marker propagates. Checked via the caller-supplied
 *      `stallTimedOut` flag (from `timeouts.stall.timedOut()`) AND the error
 *      message, so either signal is sufficient. A stall after content has been
 *      emitted is always fatal (mirrors anthropic-direct/loop/stream-consumer.ts).
 *      TTFB watchdog is checked the same way — `ttfbTimedOut` wins over a
 *      network_termination that races the TTFB abort signal.
 *   2. TTFB timeout (by error message or watchdog flag) — retried if budget allows.
 *   3. Status-bearing retryable error (429 / 5xx) — retried if budget allows.
 *   4. Mid-stream network termination (TypeError: terminated / ECONNRESET /
 *      UND_ERR_SOCKET / UND_ERR_CLOSED):
 *      a. If the stream already delivered a terminal finish_reason, the response
 *         is complete — accept it instead of retrying or erroring (P2 fix).
 *      b. Otherwise, retried EVEN IF content was already yielded, matching the
 *         status-retry path. The outer loop emits `stream.retry` before
 *         re-connecting, which resets partial text on the consumer side. Falls
 *         through as fatal once the shared budget is exhausted.
 *
 * The caller already checked `ctx.controller.signal.aborted` (the user/turn
 * signal) before calling here, so a user interrupt never reaches this function.
 *
 * Contract: pure — no I/O, no closures over outer locals. All required state
 * is passed explicitly so the function remains unit-testable in isolation.
 *
 * @param err                       - The error thrown by the stream iterator.
 * @param contentYieldedThisAttempt - Whether any translated events were yielded.
 * @param streamRetries             - Current retry count (will be incremented
 *   inside for retry actions).
 * @param stallMs                   - The stall timeout in ms (for the error msg).
 * @param stallTimedOut             - Whether the stall watchdog already fired
 *   (`timeouts.stall.timedOut()`). When true, a transport termination is treated
 *   as a stall outcome, never as a retriable network_termination (P1 fix).
 * @param ttfbTimedOut              - Whether the TTFB watchdog already fired
 *   (`timeouts.ttfb.timedOut()`). When true, a transport termination that raced
 *   the TTFB abort is classified as a TTFB retry, not network_termination (P1).
 * @param terminalFinishReason      - The finish_reason already set in StreamState,
 *   or null when none arrived yet. A non-null value means the response is complete
 *   even though the transport dropped afterward (P2 fix).
 * @returns A {@link StreamErrorAction} describing what the caller must do, and
 *   the updated `streamRetries` count (already incremented for retry actions).
 */
export function classifyStreamError(
  err: unknown,
  contentYieldedThisAttempt: boolean,
  streamRetries: number,
  stallMs: number,
  stallTimedOut = false,
  ttfbTimedOut = false,
  terminalFinishReason: string | null = null,
): { action: StreamErrorAction; newStreamRetries: number } {
  // Branch 1: stall timeout — must win over network_termination.
  //
  // Contract: two independent signals gate this branch — the watchdog flag AND
  // the error message. Either is sufficient because there is a race between the
  // watchdog abort propagating through abortableStream (surfacing as the marker
  // error) and the transport itself throwing TypeError('terminated') when its
  // underlying socket closes. Whichever settles first in Promise.race wins, but
  // if the stall watchdog fired, the outcome MUST be treated as a stall, not as
  // a retriable network drop.
  if (stallTimedOut || isStallTimeoutError(err)) {
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

  // Branch 2: TTFB timeout — checked by flag and by error message for the same
  // race reason as Branch 1. Only retry if budget allows.
  if ((ttfbTimedOut || isTtfbTimeoutError(err)) && streamRetries < MAX_STREAM_RETRIES) {
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

  // Branch 3: status-bearing retryable error (429 / 5xx).
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

  // Branch 4: mid-stream transport termination (TypeError: terminated, ECONNRESET, …).
  if (isMidStreamNetworkTermination(err)) {
    // P2: if a terminal finish_reason already arrived, the response is complete —
    // the transport reset happened AFTER the payload was fully delivered (e.g. a
    // proxy closes the TCP connection after sending the last SSE chunk but before
    // the iterator observes a clean EOF). Accept the accumulated state and let the
    // normal post-loop path handle tool dispatch / completion, instead of retrying
    // and re-billing a generation that already finished.
    if (terminalFinishReason !== null) {
      return {
        action: { kind: 'accept' },
        newStreamRetries: streamRetries,
      };
    }

    // Otherwise retry while the shared budget holds.
    if (streamRetries < MAX_STREAM_RETRIES) {
      const next = streamRetries + 1;
      return {
        action: {
          kind: 'retry',
          delay: computeBackoffDelay(next - 1),
          source: 'stream',
          reason: 'network_termination',
          attempt: next,
        },
        newStreamRetries: next,
      };
    }
  }

  return {
    action: { kind: 'fall-through', error: err },
    newStreamRetries: streamRetries,
  };
}
