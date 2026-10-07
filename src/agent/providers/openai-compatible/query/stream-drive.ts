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
 * checks, TTFB-once semantics, and the return shape are preserved verbatim),
 * with first-byte and stream-stall timeouts now wired (mirrors anthropic-direct).
 *
 * The function-body helpers (connection phase, stream-error classification,
 * emit-and-sleep) live in the sibling files stream-drive.connection.ts,
 * stream-drive.stream-error.ts, and stream-drive.retry.ts respectively.
 *
 * @module agent/providers/openai-compatible/query/stream-drive
 */

import type { ProviderEvent } from '../../../provider.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import type { TraceSink } from '../../../trace/index.js';
import { abortableStream } from '../../shared/abortable-stream.js';
import {
  resolveTtfbTimeoutMs,
} from '../../shared/first-byte-timeout.js';
import {
  resolveStallTimeoutMs,
} from '../../shared/stream-stall-timeout.js';
import { armAttemptTimeouts } from './stream-timeouts.js';
import { createStreamState, isToolCallStop, type StreamState } from '../translate.js';
import { StreamIncompleteError } from '../../../../utils/errors.js';
import {
  MAX_STREAM_RETRIES,
  computeBackoffDelay,
} from './retry.js';
import { runConnectionPhase } from './stream-drive.connection.js';
import { emitAndSleepRetry } from './stream-drive.retry.js';
import { classifyStreamError } from './stream-drive.stream-error.js';

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
  /** Defaults to Chat Completions semantics; Responses usage is terminal, not trailing. */
  expectsTrailingUsage?: boolean;
}

/** Session-scoped context the driver needs but does not own. */
export interface StreamDriveContext {
  controller: AbortController;
  traceWriter: TraceSink | undefined;
  initSessionId: string;
  currentModel: string;
  endpoint?: string;
  /** Live liveness check — the query sets this true on close(). */
  isClosed: () => boolean;
  /**
   * Optional override for TTFB timeout ms (tests inject small values here).
   * When undefined, resolved from AFK_MODEL_TTFB_TIMEOUT_MS env.
   */
  ttfbTimeoutMs?: number;
  /**
   * Optional override for stall timeout ms (tests inject small values here).
   * When undefined, resolved from AFK_MODEL_STALL_TIMEOUT_MS env.
   */
  stallTimeoutMs?: number;
}

/**
 * Drive one iteration's streaming round-trip with connection + mid-stream retry.
 * Yields the translated {@link ProviderEvent}s and returns the
 * {@link IterationResult} on clean completion, or `null` on abort / close /
 * surfaced error (after yielding the `error` event in the error case).
 *
 * First-byte (TTFB) and stream-stall watchdogs are armed per attempt, mirroring
 * anthropic-direct/loop.ts. A TTFB timeout before any chunk is retryable (up to
 * MAX_STREAM_RETRIES); a stall after content has been emitted is fatal (mirrors
 * anthropic-direct — it is surfaced via stallTimeoutError).
 *
 * Connection phase: {@link runConnectionPhase} (stream-drive.connection.ts).
 * Stream-error classification: {@link classifyStreamError} (stream-drive.stream-error.ts).
 * Emit+sleep helper: {@link emitAndSleepRetry} (stream-drive.retry.ts).
 */
export async function* driveStream<TEvent>(
  ctx: StreamDriveContext,
  strategy: StreamDriveStrategy<TEvent>,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  const ttfbMs = ctx.ttfbTimeoutMs ?? resolveTtfbTimeoutMs();
  const stallMs = ctx.stallTimeoutMs ?? resolveStallTimeoutMs();

  // Retry loop: connection-phase + mid-stream retry with exponential backoff.
  let streamRetries = 0;
  for (;;) {
    const state = createStreamState();
    const requestStartedAt = Date.now();

    // Arm TTFB + stall guards per attempt. Chain: turn → ttfb → stall.
    const timeouts = armAttemptTimeouts(ctx.controller.signal, ttfbMs, stallMs);

    let contentYieldedThisAttempt = false;

    try {
      // ── Connection phase ──────────────────────────────────────────────
      // Item 2: pass timeouts.signal as the sleep signal so the TTFB watchdog
      // can abort a long retry-after sleep and trigger the retryable TTFB path.
      const conn = await runConnectionPhase(
        strategy.createStream,
        timeouts.signal,
        ctx.controller.signal,
        ctx.traceWriter,
        ctx.currentModel,
        ctx.endpoint,
      );

      if (!conn.ok) {
        if (conn.error === 'aborted') return null;
        // TTFB fired during connection: retryable if budget allows.
        if (timeouts.ttfb.timedOut() && streamRetries < MAX_STREAM_RETRIES) {
          streamRetries++;
          yield { type: 'stream.retry', sessionId: ctx.initSessionId };
          const delay = computeBackoffDelay(streamRetries - 1);
          const userAborted = await emitAndSleepRetry(
            ctx.traceWriter, ctx.currentModel, delay,
            ctx.controller.signal, ctx.controller.signal,
            { source: 'connection', reason: 'ttfb_timeout', attempt: streamRetries },
          );
          if (userAborted) return null;
          continue;
        }
        yield { type: 'error', error: strategy.clarifyError(conn.error) };
        return null;
      }

      // ── Mid-stream consumption with retry ───────────────────────────
      let streamError: unknown = null;
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
        // terminal, no bogus error. Uses `timeouts.signal` — the user/turn
        // interrupt chained with the TTFB + stall watchdogs, the same signal handed
        // to `createStream` — so a watchdog abort also halts a parked pull promptly.
        for await (const event of abortableStream(conn.stream, timeouts.signal)) {
          if (ctx.isClosed()) return null;
          // Raw chunk received — signal TTFB seen and advance stall watchdog.
          if (!ttfbEmitted) timeouts.ttfb.firstByteSeen();
          timeouts.stall.progress();

          for (const ev of strategy.translate(event, state)) {
            if (!ttfbEmitted) {
              ttfbEmitted = true;
              void emitSessionPhase(ctx.traceWriter, {
                phase: 'model_ttfb',
                durationMs: Date.now() - requestStartedAt,
                resolvedModel: ctx.currentModel,
              });
            }
            contentYieldedThisAttempt = true;
            yield ev;
          }
        }
      } catch (err) {
        // User interrupt check must use ctx.controller.signal (the TURN signal),
        // NOT timeouts.signal — watchdog aborts propagate through timeouts.signal
        // but not through ctx.controller.signal, keeping them distinguishable.
        if (ctx.controller.signal.aborted) return null;

        const { action, newStreamRetries } = classifyStreamError(
          err,
          contentYieldedThisAttempt,
          streamRetries,
          stallMs,
          timeouts.stall.timedOut(),
          timeouts.ttfb.timedOut(),
          state.finishReason,
          state.usage !== null,
          strategy.expectsTrailingUsage ?? true,
        );
        streamRetries = newStreamRetries;

        if (action.kind === 'retry') {
          yield { type: 'stream.retry', sessionId: ctx.initSessionId };
          const retryMeta: Record<string, string | number | boolean> = {
            source: action.source,
            reason: action.reason,
            attempt: action.attempt,
          };
          if (action.errorCode !== undefined) retryMeta['errorCode'] = action.errorCode;
          if (action.awaitingUsage) retryMeta['awaitingUsage'] = true;
          const userAborted = await emitAndSleepRetry(
            ctx.traceWriter, ctx.currentModel, action.delay,
            ctx.controller.signal, ctx.controller.signal,
            retryMeta,
          );
          if (userAborted) return null;
          continue;
        }
        if (action.kind === 'fatal') {
          yield { type: 'error', error: strategy.clarifyError(action.error) };
          return null;
        }
        if (action.kind === 'accept') {
          // P2: terminal finish_reason arrived before the transport dropped.
          // The response is complete — fall through from the catch block into
          // the post-loop path (streamError stays null, so the error guard below
          // is a no-op) and return the accumulated state as a clean completion.
          // The stream-incomplete guard is also a no-op because state.finishReason
          // is non-null (that is the exact condition that produced AcceptAction).
          //
          // Emit an observability event so an accepted-after-drop turn is
          // distinguishable from a clean finish in traces (#2780).
          void emitSessionPhase(ctx.traceWriter, {
            phase: 'stream_accepted_after_drop',
            resolvedModel: ctx.currentModel,
            metadata: { usageReceived: state.usage !== null },
          });
        } else {
          // fall-through: treat as a surfaced stream error below
          streamError = action.error;
        }
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
      // finish_reason). This catches three truncation shapes:
      //   1. truly-empty streams (no content at all);
      //   2. reasoning-only cut-offs — reasoning deltas arrived but the stream was
      //      cut before any visible answer (reasoningText > 0, assistantText empty);
      //   3. cut-off / non-dispatchable partial tool calls — missing id or name.
      if (state.finishReason === null && state.assistantText.length === 0 && !needsToolDispatch) {
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

      return { state, events: [], text: state.assistantText, needsToolDispatch };
    } finally {
      // Dispose both handles on every exit path (normal, continue, throw).
      timeouts.dispose();
    }
  }
}
