/**
 * Shared retry / stream-drive skeleton for
 * {@link OpenAICompatibleQuery.runIteration}.
 *
 * The Responses-API and Chat-Completions wire branches ran two near-identical
 * copies of the same three-phase scaffolding — build request body (done by the
 * caller), connection-phase retry, mid-stream consume with once-only
 * `model_ttfb` emission + stream-retry, and a clean-completion return. Only four
 * things differed per wire: how the stream is opened, its raw event type, how a
 * raw event is translated, and how an error is surfaced. This module holds the
 * one shared driver, parameterized by a {@link StreamDriveStrategy}; each wire
 * branch now just builds its request body and calls {@link driveStream}.
 *
 * Behavior is identical to the two former inline copies (retry counts, abort
 * checks, TTFB-once semantics, and the return shape are preserved verbatim).
 *
 * @module agent/providers/openai-compatible/query/stream-drive
 */

import type { ProviderEvent } from '../../../provider.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { TraceWriter } from '../../../trace/index.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { createStreamState, isToolCallStop, type StreamState } from '../translate.js';
import {
  MAX_CONNECTION_RETRIES,
  MAX_STREAM_RETRIES,
  computeBackoffDelay,
  isRetryableConnectionError,
  isRetryableStreamError,
} from './retry.js';

/** Result of a single model round-trip, consumed by the tool-loop orchestrator. */
export interface IterationResult {
  state: StreamState;
  events: ProviderEvent[];
  /** Final assistant text accumulated this iteration. */
  text: string;
  /** True when this iteration ended in tool_calls (we need to dispatch and loop). */
  needsToolDispatch: boolean;
}

/** The four per-wire deltas the shared driver is parameterized over. */
export interface StreamDriveStrategy<TEvent> {
  /** Open the streaming connection for this wire (throws on connection failure). */
  createStream: (signal: AbortSignal) => Promise<AsyncIterable<TEvent>>;
  /** Translate one raw wire event into zero or more ProviderEvents, mutating `state`. */
  translate: (event: TEvent, state: StreamState) => Iterable<ProviderEvent>;
  /** Coerce a connection- or stream-phase error into the Error surfaced for this wire. */
  clarifyError: (err: unknown) => Error;
}

/** Session-scoped context the driver needs but does not own. */
export interface StreamDriveContext {
  controller: AbortController;
  traceWriter: TraceWriter | undefined;
  initSessionId: string;
  currentModel: string;
  /** Live liveness check — the query sets this true on close(). */
  isClosed: () => boolean;
}

/**
 * Drive one iteration's streaming round-trip with connection + mid-stream retry.
 * Yields the translated {@link ProviderEvent}s and returns the
 * {@link IterationResult} on clean completion, or `null` on abort / close /
 * surfaced error (after yielding the `error` event in the error case).
 */
export async function* driveStream<TEvent>(
  ctx: StreamDriveContext,
  strategy: StreamDriveStrategy<TEvent>,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  // Retry loop: connection-phase + mid-stream retry with exponential backoff.
  // Mirrors the Anthropic provider's createWithRetry + overload retry pattern
  // (see `anthropic-direct/loop.ts`). State is reset on each retry so the
  // re-driven request starts from a clean slate.
  let streamRetries = 0;
  for (;;) {
    const state = createStreamState();

    // Witness layer: stamp request-initiation time for model_ttfb below.
    const requestStartedAt = Date.now();

    // ── Connection-phase retry ──────────────────────────────────────
    let stream: AsyncIterable<TEvent>;
    let connectionError: unknown = null;
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await strategy.createStream(ctx.controller.signal);
        break; // connection succeeded
      } catch (err) {
        if (ctx.controller.signal.aborted) return null;
        if (isRetryableConnectionError(err) && attempt < MAX_CONNECTION_RETRIES) {
          const delay = computeBackoffDelay(attempt);
          await sleepWithAbort(delay, ctx.controller.signal);
          if (ctx.controller.signal.aborted) return null;
          continue;
        }
        connectionError = err;
        break;
      }
    }

    if (connectionError !== null) {
      yield { type: 'error', error: strategy.clarifyError(connectionError) };
      return null;
    }

    // ── Mid-stream consumption with retry ───────────────────────────
    let streamError: unknown = null;
    // Witness layer: emit model_ttfb exactly once per API call, on the first
    // translated stream event. Reset per for(;;) iteration so each
    // retry-driven call reports its own time-to-first-byte. Mirrors
    // anthropic-direct/loop.ts:307–327.
    let ttfbEmitted = false;
    try {
      for await (const event of stream!) {
        if (ctx.isClosed()) return null;
        for (const ev of strategy.translate(event, state)) {
          if (!ttfbEmitted) {
            ttfbEmitted = true;
            void emitSessionPhase(ctx.traceWriter, {
              phase: 'model_ttfb',
              durationMs: Date.now() - requestStartedAt,
              resolvedModel: ctx.currentModel,
            });
          }
          yield ev;
        }
      }
    } catch (err) {
      if (ctx.controller.signal.aborted) return null;
      if (isRetryableStreamError(err) && streamRetries < MAX_STREAM_RETRIES) {
        streamRetries++;
        yield { type: 'stream.retry', sessionId: ctx.initSessionId };
        await sleepWithAbort(computeBackoffDelay(streamRetries - 1), ctx.controller.signal);
        if (ctx.controller.signal.aborted) return null;
        continue; // retry the whole iteration
      }
      streamError = err;
    }

    if (streamError !== null) {
      yield { type: 'error', error: strategy.clarifyError(streamError) };
      return null;
    }

    // Clean completion — return the result.
    return {
      state,
      events: [],
      text: state.assistantText,
      needsToolDispatch: isToolCallStop(state) && state.toolCallsByIndex.size > 0,
    };
  }
}
