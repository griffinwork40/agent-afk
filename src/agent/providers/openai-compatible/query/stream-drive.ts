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
import { abortableStream } from '../../shared/abortable-stream.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { createStreamState, isToolCallStop, type StreamState } from '../translate.js';
import { StreamIncompleteError } from '../../../../utils/errors.js';
import {
  MAX_CONNECTION_RETRIES,
  MAX_STREAM_RETRIES,
  computeBackoffDelay,
  isRetryableConnectionError,
  isRetryableStreamError,
  retryAfterDelayMs,
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
          // Honor a server `retry-after` hint (clamped) over blind exponential
          // backoff — the endpoint's own advised interval on a 429/503.
          const hinted = retryAfterDelayMs(err);
          const delay = hinted ?? computeBackoffDelay(attempt);
          // Witness layer: record the wait so it is legible in `afk trace show`
          // (mirrors retry-layer.ts's `rate_limit` phase). Fire-and-forget so
          // trace latency never stalls the retry.
          void emitSessionPhase(ctx.traceWriter, {
            phase: 'rate_limit',
            durationMs: delay,
            resolvedModel: ctx.currentModel,
            metadata: {
              source: 'connection',
              reason: hinted !== undefined ? 'retry-after' : 'backoff',
              attempt,
            },
          });
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
      // Race every stream pull against the turn signal so an ESC interrupt halts
      // PROMPTLY (same event-loop turn) instead of waiting for the SDK's parked
      // read to settle — mirrors anthropic-direct/loop.ts. This matters MORE on
      // this wire: openai@6's SSE iterator SWALLOWS a mid-stream abort and ends
      // cleanly (node_modules/openai/core/streaming.mjs — `if (isAbortError(e))
      // return;`), so without the wrapper an interrupt not only lags behind the
      // keypress but the clean end falls THROUGH to the stream-incomplete guard
      // below and yields a spurious `error` event. `abortableStream` throws an
      // AbortError the instant the signal fires; the catch's `aborted` branch
      // then returns null and the caller emits exactly one terminal
      // `turn.completed` (openai-compatible/query.ts:_runTurnInner) — no double
      // terminal, no bogus error. Uses `controller.signal` (the user/turn
      // interrupt) — the same signal handed to `createStream`.
      for await (const event of abortableStream(stream!, ctx.controller.signal)) {
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
        // Honor a server `retry-after` hint (clamped) over blind exponential
        // backoff, same as the connection phase above.
        const hinted = retryAfterDelayMs(err);
        const delay = hinted ?? computeBackoffDelay(streamRetries - 1);
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'rate_limit',
          durationMs: delay,
          resolvedModel: ctx.currentModel,
          metadata: {
            source: 'stream',
            reason: hinted !== undefined ? 'retry-after' : 'backoff',
            attempt: streamRetries,
          },
        });
        await sleepWithAbort(delay, ctx.controller.signal);
        if (ctx.controller.signal.aborted) return null;
        continue; // retry the whole iteration
      }
      streamError = err;
    }

    if (streamError !== null) {
      yield { type: 'error', error: strategy.clarifyError(streamError) };
      return null;
    }

    // Interrupt short-circuit: if the turn signal fired we are here because the
    // stream ended on abort — return a clean null so the caller emits a single
    // terminal `turn.completed`, NEVER an error. The `abortableStream` wrapper
    // above normally throws an AbortError on interrupt (caught → the `aborted`
    // branch returns null before we reach this point), so this is defense in
    // depth: it guarantees an interrupt can never fall through to the
    // stream-incomplete guard below and yield a spurious `error` event even if a
    // future transport ends the pull cleanly on abort instead of rejecting.
    if (ctx.controller.signal.aborted) return null;

    // Tool-dispatch intent, computed once: the incomplete-stream guard below and
    // the clean-completion return value both key off it. `isToolCallStop` is a
    // pure read of the now-fully-accumulated `state`.
    const needsToolDispatch = isToolCallStop(state) && state.toolCallsByIndex.size > 0;

    // Invariant: the stream iterator completed WITHOUT throwing but produced no
    // DISPATCHABLE response AND no terminal finish_reason — the wire never
    // signaled completion and nothing usable was generated (a stream cut off
    // before the answer arrived, e.g. an intermediary closing the connection at a
    // graceful boundary; a hard drop would have thrown and been surfaced above).
    // Returning a clean completion here delivers an empty turn as success — a
    // silent failure. Surface an error instead, mirroring anthropic-direct's
    // stream-incomplete handling and the #628 "fail loudly, don't silently
    // succeed" fix.
    //
    // Scope: NO VISIBLE ANSWER AND NO DISPATCHABLE TOOL CALL (with no
    // finish_reason). This catches three truncation shapes that all reduce to
    // "empty turn presented as success":
    //   1. truly-empty streams (no content at all);
    //   2. reasoning-only cut-offs — reasoning deltas arrived but the stream was
    //      cut before any visible answer (reasoningText > 0, assistantText empty);
    //   3. cut-off / non-dispatchable partial tool calls — an accumulated call is
    //      missing its id or name, so isToolCallStop() is false (see
    //      translate.ts:218) and it can never round-trip.
    // All three leave runTurn with text === '' and needsToolDispatch === false,
    // so it would otherwise emit an empty assistant.message + turn.completed as a
    // clean success — the exact silent-truncation failure this guard exists to
    // prevent.
    //
    // We deliberately do NOT flag a clean end that produced VISIBLE TEXT or a
    // DISPATCHABLE tool call but omitted finish_reason: some OpenAI-compatible
    // endpoints (local MLX / llama.cpp shims) legitimately OMIT finish_reason on
    // complete turns, so treating "usable content present + no finish_reason" as
    // incomplete would false-positive real completions. finish_reason is not a
    // reliable terminal signal on this wire (unlike anthropic-direct's
    // protocol-guaranteed message_stop), so the content-present partial-truncation
    // case still cannot be safely distinguished here and is left unflagged.
    if (
      state.finishReason === null &&
      state.assistantText.length === 0 &&
      !needsToolDispatch
    ) {
      yield {
        type: 'error',
        error: new StreamIncompleteError(
          'the model stream ended without a finish_reason and without a ' +
            'dispatchable response (no visible answer text and no complete tool ' +
            'call): the response was empty or cut off before any usable content ' +
            'arrived. The turn is incomplete.',
        ),
      };
      return null;
    }

    // Clean completion — return the result.
    return {
      state,
      events: [],
      text: state.assistantText,
      needsToolDispatch,
    };
  }
}
