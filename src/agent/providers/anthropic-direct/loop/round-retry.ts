/**
 * Re-drive handling for one anthropic-direct turn round.
 *
 * Owns what happens AFTER {@link ../loop/stream-consumer.consumeRoundStream}
 * decides a round should be retried: the witness trace phase, the `stream.retry`
 * surface reset, the class-appropriate backoff, and the abort check that runs
 * once the backoff is served.
 *
 * Invariant: this module SPENDS the same {@link RoundRetryBudget} instance the
 * stream consumer READS. They must be handed the same object — a copy would
 * silently grant every round an unlimited allowance. The budget is released as
 * a unit by `RoundRetryBudget.reset()` once a round gets past every retry
 * decision.
 *
 * @module agent/providers/anthropic-direct/loop/round-retry
 */

import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { jitterBackoff } from '../overload-pause.js';
import type { RetryOutcome, RetryReason } from './outcomes.js';
import {
  OVERLOAD_BASE_DELAY_MS,
  type RoundRetryBudget,
  STREAM_INCOMPLETE_BASE_DELAY_MS,
} from './retry-budget.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/**
 * Emit the trace + surface events for a single time-to-first-byte-timeout
 * re-drive. Mirrors the mid-stream overload retry's signalling: a dedicated
 * `ttfb_timeout` trace phase (so the re-drive is legible in `afk trace show`)
 * plus a `stream.retry` event so surfaces discard any partial paint. No backoff
 * sleep — the point is to fail-fast off a stalled endpoint, and the single
 * retry is gated by the per-round `ttfbRetried` flag so it cannot stack.
 *
 * The phase is NOT `rate_limit`: this timer is ours, fires with no server
 * throttle and no retry-after, and the two are otherwise indistinguishable in a
 * trace — which made every self-inflicted 180s stall read as provider
 * throttling. `metadata.reason` stays `'ttfb-timeout'` so analyses written
 * against the pre-split shape keep matching.
 */
async function* emitTtfbRetry(
  input: RunTurnInput,
  requestStartedAt: number,
): AsyncGenerator<ProviderEvent, void, void> {
  void emitSessionPhase(input.traceWriter, {
    phase: 'ttfb_timeout',
    durationMs: Date.now() - requestStartedAt,
    metadata: { reason: 'ttfb-timeout', source: 'first-byte', resolvedModel: input.model },
  });
  yield { type: 'stream.retry', sessionId: input.ctx.sessionId };
}

/** Everything a retry decision needs from the enclosing turn. */
export interface RoundRetryContext {
  input: RunTurnInput;
  turn: TurnAccumulator;
  /** The SAME budget instance the stream consumer read. */
  retry: RoundRetryBudget;
  /** When this round's `messages.create` was initiated, for the trace duration. */
  requestStartedAt: number;
}

/**
 * Serve one retry of the given class, then report whether the orchestrator
 * should re-drive the round or return.
 *
 * Returns `'terminated'` only when the turn signal aborted DURING the backoff —
 * in which case the terminal `turn.completed` has already been yielded here.
 */
export async function* handleRoundRetry(
  reason: RetryReason,
  { input, turn, retry, requestStartedAt }: RoundRetryContext,
): AsyncGenerator<ProviderEvent, RetryOutcome, void> {
  if (reason === 'ttfb') {
    // No backoff and no abort re-check: the re-drive is immediate by design, so
    // there is no window in which the signal could fire unobserved.
    yield* emitTtfbRetry(input, requestStartedAt);
    retry.ttfbRetried = true;
    return 'continue';
  }

  if (reason === 'overload') {
    retry.overloadRetries += 1;
    // Witness layer: record the mid-stream overload backoff so a re-driven
    // round is legible in the trace. The tracing-fetch wrapper cannot see this
    // one — a mid-stream `overloaded_error` arrives in the SSE body of an HTTP
    // 200 response, so it never trips the wrapper's status check.
    // Fire-and-forget; trace latency must never stall the retry.
    void emitSessionPhase(input.traceWriter, {
      phase: 'rate_limit',
      metadata: { reason: 'overloaded', source: 'mid-stream', attempt: retry.overloadRetries },
    });
    // Tell surfaces to discard the current round's already-streamed text: the
    // re-driven request below re-streams the round from scratch, so without a
    // reset the partial text visibly duplicates. Emitted before the backoff so
    // the UI clears immediately rather than after the wait.
    yield { type: 'stream.retry', sessionId: input.ctx.sessionId };
    // Exponential backoff matching createWithRetry: 5s → 10s → 20s, plus
    // additive jitter (#762) so parallel sessions/subagents that all hit the
    // same capacity event de-synchronize instead of re-hammering an already-
    // overloaded upstream in lockstep. Mirrors the transient-429 jitter at
    // retry-layer.ts.
    yield* serveBackoff(
      jitterBackoff(OVERLOAD_BASE_DELAY_MS * Math.pow(2, retry.overloadRetries - 1)),
      input,
      turn,
    );
    return input.signal.aborted ? 'terminated' : 'continue';
  }

  retry.streamIncompleteRetries += 1;
  // Witness layer: log the mid-stream-cut re-drive so it is legible in
  // `afk trace show`. Reuse the `rate_limit` phase as the generic retry/backoff
  // marker (the TTFB and overload re-drives do the same) with a distinct
  // `reason`. Fire-and-forget; trace latency must never stall the retry.
  void emitSessionPhase(input.traceWriter, {
    phase: 'rate_limit',
    metadata: {
      reason: 'stream-incomplete',
      source: 'mid-stream',
      attempt: retry.streamIncompleteRetries,
    },
  });
  // Tell surfaces to discard the current round's already-streamed text: the
  // re-driven request re-streams the round from scratch, so without a reset any
  // partial text visibly duplicates. Emitted before the delay so the UI clears
  // immediately rather than after the wait.
  yield { type: 'stream.retry', sessionId: input.ctx.sessionId };
  // Short settle delay (1s → 2s), NOT overload's 5s/10s/20s: a dropped
  // connection is not a server-overload signal, so reconnect promptly while
  // still avoiding a tight hammer loop against a flapping intermediary.
  yield* serveBackoff(
    STREAM_INCOMPLETE_BASE_DELAY_MS * Math.pow(2, retry.streamIncompleteRetries - 1),
    input,
    turn,
  );
  return input.signal.aborted ? 'terminated' : 'continue';
}

/**
 * Sleep out a backoff and, if the turn was interrupted while waiting, yield the
 * terminal `turn.completed` so the caller can simply report `'terminated'`.
 */
async function* serveBackoff(
  delayMs: number,
  input: RunTurnInput,
  turn: TurnAccumulator,
): AsyncGenerator<ProviderEvent, void, void> {
  await sleepWithAbort(delayMs, input.signal);
  if (input.signal.aborted) {
    yield {
      type: 'turn.completed',
      usage: turn.terminalUsage(),
      sessionId: input.ctx.sessionId,
    };
  }
}
