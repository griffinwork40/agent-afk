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
  TTFB_TIMEOUT_MESSAGE,
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
  /**
   * Sanitized error code from the transport error, set only when `err.code` or
   * `err.cause.code` matches /^[A-Z][A-Z0-9_]*$/ (never message text). Used by
   * the caller to thread a safe code into retry-trace metadata without re-reading
   * the original error. Absent when no matching code exists.
   */
  errorCode?: string;
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
 *   2. TTFB timeout (by error message or watchdog flag):
 *      a. Retried if budget allows.
 *      b. When budget is exhausted, returns a fatal action with a TTFB timeout
 *         error (reusing err when it already carries the TTFB message, or
 *         constructing one from TTFB_TIMEOUT_MESSAGE) so the caller sees a
 *         proper TTFB error rather than a raw TypeError('terminated') fall-through.
 *   3. Status-bearing retryable error (429 / 5xx) — retried if budget allows.
 *   4. Mid-stream network termination (TypeError: terminated / ECONNRESET /
 *      UND_ERR_SOCKET / UND_ERR_CLOSED):
 *      a. If the stream delivered a terminal finish_reason AND the trailing usage
 *         chunk arrived (`usageReceived`), the response is fully complete — accept
 *         it instead of retrying or erroring (P2 fix).
 *      b. If finish_reason arrived but usage did not yet, retry while budget
 *         allows (the usage-only trailing chunk may arrive on the next attempt);
 *         once the budget is exhausted, accept anyway — the content is complete
 *         and failing the turn is worse than degraded usage.
 *      c. Otherwise (no finish_reason), retried EVEN IF content was already
 *         yielded, matching the status-retry path. The outer loop emits
 *         `stream.retry` before re-connecting, which resets partial text on the
 *         consumer side. Falls through as fatal once the shared budget is exhausted.
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
 *   or null when none arrived yet. A non-null value means the response body has
 *   been fully delivered even if the transport dropped afterward (P2 fix).
 * @param usageReceived             - Whether the trailing usage-only chunk has
 *   already been received (`state.usage !== null`). On Chat Completions the
 *   usage chunk arrives AFTER the finish_reason chunk, so a drop between them
 *   leaves `usageReceived=false`. When false and finish_reason is present, we
 *   retry (the usage may arrive on the next attempt); once the budget is
 *   exhausted we accept anyway with degraded (missing) usage rather than fail
 *   the turn. Ignored when `terminalFinishReason` is null.
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
  usageReceived = false,
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
  // race reason as Branch 1.
  if (ttfbTimedOut || isTtfbTimeoutError(err)) {
    if (streamRetries < MAX_STREAM_RETRIES) {
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
    // Budget exhausted: surface a proper TTFB error rather than falling through
    // as a raw TypeError('terminated') — reuse err when it already carries the
    // TTFB message, otherwise construct a canonical one.
    const ttfbErr =
      err instanceof Error && err.message === TTFB_TIMEOUT_MESSAGE
        ? err
        : new Error(TTFB_TIMEOUT_MESSAGE);
    return {
      action: { kind: 'fatal', error: ttfbErr },
      newStreamRetries: streamRetries,
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
    // Extract a sanitized error code for trace metadata (#2780). Only codes
    // matching /^[A-Z][A-Z0-9_]*$/ are safe to surface — never message text.
    const safeCodeRe = /^[A-Z][A-Z0-9_]*$/;
    const rawCode =
      (err as Record<string, unknown>)['code'] ??
      ((err as { cause?: Record<string, unknown> }).cause?.['code']);
    const errorCode =
      typeof rawCode === 'string' && safeCodeRe.test(rawCode) ? rawCode : undefined;

    if (terminalFinishReason !== null) {
      if (usageReceived) {
        // P2a: finish_reason AND usage arrived — the response is fully complete.
        // The transport reset happened after the payload was delivered. Accept.
        return {
          action: { kind: 'accept' },
          newStreamRetries: streamRetries,
        };
      }
      if (streamRetries < MAX_STREAM_RETRIES) {
        // P2b: finish_reason arrived but the trailing usage chunk did not yet.
        // Retry so the usage can arrive on the next attempt.
        const next = streamRetries + 1;
        return {
          action: {
            kind: 'retry',
            delay: computeBackoffDelay(next - 1),
            source: 'stream',
            reason: 'network_termination',
            attempt: next,
            errorCode,
          },
          newStreamRetries: next,
        };
      }
      // Budget exhausted but content is complete — accept with degraded usage.
      // Failing the turn is worse than missing usage data.
      return {
        action: { kind: 'accept' },
        newStreamRetries: streamRetries,
      };
    }

    // No finish_reason: retry while the shared budget holds.
    if (streamRetries < MAX_STREAM_RETRIES) {
      const next = streamRetries + 1;
      return {
        action: {
          kind: 'retry',
          delay: computeBackoffDelay(next - 1),
          source: 'stream',
          reason: 'network_termination',
          attempt: next,
          errorCode,
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
