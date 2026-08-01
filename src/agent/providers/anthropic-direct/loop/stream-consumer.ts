/**
 * Stream-consumption phase of one anthropic-direct turn round.
 *
 * Drives the raw SDK event iterable through {@link translateMessageStream},
 * yields every translated `ProviderEvent`, and classifies how the round ended
 * into a {@link RoundOutcome} the orchestrator can switch on.
 *
 * Invariant: this module READS the {@link RoundRetryBudget} to decide whether a
 * retry class still has allowance, but does NOT spend it — `round-retry.ts`
 * does that. Both must be handed the SAME budget instance.
 *
 * Invariant: timer disposal is duplicated on purpose. `ttfb.dispose()` /
 * `stall.dispose()` are called on each early-exit path AND once more at the end
 * of the phase. Both handles are idempotent, and the pre-split loop did exactly
 * this — do not consolidate the calls into a `finally`, which would also fire
 * on paths that deliberately leave the timers armed for the caller.
 *
 * @module agent/providers/anthropic-direct/loop/stream-consumer
 */

import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput, TurnResult } from '../types.js';
import { translateMessageStream } from '../translate.js';
import { StreamIncompleteError } from '../../../../utils/errors.js';
import { abortableStream } from '../../shared/abortable-stream.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { env } from '../../../../config/env.js';
import type { FirstByteTimeoutHandle } from '../../shared/first-byte-timeout.js';
import {
  isStallTimeoutError,
  type StreamStallHandle,
  stallTimeoutError,
} from '../../shared/stream-stall-timeout.js';
import { isOverloadedErrorEvent } from './retry-budget.js';
import type { RoundRetryBudget } from './retry-budget.js';
import type { RoundOutcome } from './outcomes.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/** Everything the stream phase needs from the round that opened the request. */
export interface StreamConsumerContext {
  /** Raw SDK event iterable returned by `messages.create`. */
  events: AsyncIterable<unknown>;
  input: RunTurnInput;
  turn: TurnAccumulator;
  /** The SAME budget instance `round-retry.ts` will spend. */
  retry: RoundRetryBudget;
  ttfb: FirstByteTimeoutHandle;
  stall: StreamStallHandle;
  /** Resolved post-first-byte stall bound, for the operator-facing error text. */
  stallTimeoutMs: number;
  /** When `messages.create` was initiated, for the `model_ttfb` duration. */
  requestStartedAt: number;
}

/**
 * Consume one round's stream to completion (or to a retry/terminal decision).
 *
 * Yields translated provider events as they arrive. The returned
 * {@link RoundOutcome} tells the orchestrator what to do next; a `terminated`
 * outcome means this function ALREADY yielded the turn's terminal event.
 */
export async function* consumeRoundStream({
  events,
  input,
  turn,
  retry,
  ttfb,
  stall,
  stallTimeoutMs,
  requestStartedAt,
}: StreamConsumerContext): AsyncGenerator<ProviderEvent, RoundOutcome, void> {
  // Translate the raw SDK events into ProviderEvents and capture the digested
  // TurnResult emitted at end-of-stream.
  let turnResult: TurnResult | null = null;
  let translatorErrored = false;
  let retryTtfb = false;
  let retryOverload = false;
  let retryStreamIncomplete = false;
  // Mid-stream overload budget exhausted for this round: routes to the clean
  // OVERLOAD_EXHAUSTED terminal instead of the fatal tail (#762).
  let overloadExhausted = false;
  // Witness layer: emit model_ttfb exactly once for this API call, on the first
  // translated stream event. Scoped per round so each model call reports its
  // own time-to-first-byte.
  let ttfbEmitted = false;

  try {
    if (env.AFK_TELEGRAM_TRACE) console.log('[loop] awaiting translateMessageStream events');
    // Race every SSE pull against the turn signal so an ESC interrupt halts
    // the stream PROMPTLY (same event-loop turn) instead of waiting for the
    // SDK's parked read to settle — which for a mid-stream Opus thinking
    // response lags seconds behind the keypress (there is no per-delta abort
    // check downstream). On abort the wrapper throws an AbortError, which
    // `translateMessageStream`'s catch converts to an in-band `error` event;
    // the error branch below then sees `input.signal.aborted` and breaks
    // WITHOUT yielding, so the caller's `turnResult === null` path emits a
    // single clean `turn.completed`. Uses `input.signal` (the user/turn
    // interrupt), NOT `ttfb.signal`, so the TTFB stall-timer path is untouched.
    for await (const out of translateMessageStream(
      abortableStream(events, input.signal) as Parameters<typeof translateMessageStream>[0],
      input.ctx,
      // Second reset source for the stall watchdog: content deltas the
      // translator consumes WITHOUT yielding (a tool call's streaming argument
      // payload, a thinking signature). Those are real output, so they must
      // re-arm the window — without this, a long `input_json_delta` run looks
      // identical to a wedged socket and gets killed as a stall. Pings
      // deliberately do not reach here (see translate.ts), so a
      // keep-alive-only stream still fires.
      () => stall.progress(),
    )) {
      // First-byte boundary = the first NON-error translated output (a real
      // content/tool event, or the end-of-stream turn-result). An in-band error
      // event is NOT a first byte — a TTFB timeout surfaces here as exactly
      // that (translate.ts converts the abort throw into an error event), so
      // gating on non-error keeps `ttfb.timedOut()` meaningful in the error
      // branch below and avoids cancelling the timer on a stall.
      const isFirstByte =
        !ttfbEmitted && (out.kind === 'turn-result' || out.event.type !== 'error');
      if (isFirstByte) {
        ttfbEmitted = true;
        // First CONTENT token arrived: cancel the stall timer so the rest of
        // this (now demonstrably progressing) stream runs unbounded — an
        // actively-streaming extended-thinking response, or any long stream
        // after its first token, is never cut off. (The bound still governs the
        // pre-first-token window, so a prefill slower than the bound is treated
        // as a stall before we ever reach here.)
        ttfb.firstByteSeen();
        // Time-to-first-byte: request initiation (incl. any auth retries inside
        // createWithRetry) → first translated stream event. Fire-and-forget;
        // trace latency must never stall the stream.
        void emitSessionPhase(input.traceWriter, {
          phase: 'model_ttfb',
          durationMs: Date.now() - requestStartedAt,
          // Resolved wire id for THIS call — captures mid-session model
          // overrides/switches that differ from the session default recorded on
          // session_init_start. `input.model` is already the resolved id passed
          // to the Messages API (see the params build).
          resolvedModel: input.model,
        });
      }
      // Observable progress for the post-first-byte stall watchdog (#762).
      // EVERY translated output re-arms the window, so "slow but streaming"
      // survives indefinitely while genuine silence fires. This is one of two
      // reset sources; the other is the `onRawProgress` callback passed above,
      // which covers content deltas that yield nothing. The first call from
      // either source ARMS the (until-now dormant) watchdog, which is why the
      // pre-first-byte window stays governed by the TTFB bound above: a
      // non-yielding delta can only precede the first translated event in
      // pathological orderings, and even then the far tighter TTFB bound fires
      // first.
      stall.progress();
      if (env.AFK_TELEGRAM_TRACE) console.log('[loop] translate yielded:', out.kind, out.kind === 'event' ? out.event.type : '');
      if (out.kind === 'event') {
        if (out.event.type === 'error') {
          // A TTFB timeout that fires after response headers but before the
          // first content event aborts the stream iterator; translate.ts
          // converts that throw into this in-band error event. `ttfb.timedOut()`
          // is true only while the timer is live (firstByteSeen clears it), and
          // ttfbEmitted is still false here (no content byte arrived) — so this
          // is unambiguously a first-byte stall. Re-drive once, then fail fast.
          if (ttfb.timedOut() && !input.signal.aborted && !retry.ttfbRetried && !ttfbEmitted) {
            retryTtfb = true;
            break;
          }
          // Post-first-byte STALL (#762): the watchdog aborted the per-request
          // controller after a full window with no translated output, and
          // translate.ts surfaced that abort as this in-band error event.
          // `input.signal.aborted` is false (we never touch the caller's
          // signal), so this is unambiguously a stall and NOT a user interrupt.
          // Deliberately NOT retried: unlike a TTFB stall (which costs only a
          // prefill) a mid-stream stall has already burned a partial
          // generation, and the pre-fix behaviour was an invisible 38–63-minute
          // hang — terminating loudly is the fix. Swap in the operator-facing
          // message so the surface shows a real diagnosis instead of a bare
          // `model_stream_stall_timeout`, then fall into the same fatal lane
          // (`translatorErrored`) that yields a terminal `error` event → real
          // `closure` → a seal that is NOT `incomplete: true`.
          if (stall.timedOut() && !input.signal.aborted) {
            yield { type: 'error', error: stallTimeoutError(stallTimeoutMs) };
            translatorErrored = true;
            break;
          }
          // Mid-stream transient overload (529 / overloaded_error): the SDK
          // throws it from inside the stream iterator with NO HTTP status, so
          // createWithRetry — status-based and connection-phase only — never
          // sees it. translate.ts has already converted that throw into this
          // in-band error event. Re-drive the request after backoff instead of
          // surfacing a fatal error: input.messages is unmutated for this round
          // (the assistant turn and usage are committed only on clean
          // completion), so the retry re-sends identical history. Any text
          // already streamed for this round may re-emit on the retry — an
          // accepted cosmetic cost vs. crashing the whole turn on a transient
          // server hiccup.
          if (
            isOverloadedErrorEvent(out.event.error) &&
            retry.canRetryOverload() &&
            !input.signal.aborted
          ) {
            retryOverload = true;
            break;
          }
          // Invariant: mid-stream overload budget EXHAUSTED must not reach the
          // fatal tail below. Before #762 it did — the guard above went false
          // on the 4th hit and control fell past the interrupt check and the
          // StreamIncomplete branch into `yield out.event; translatorErrored =
          // true`, i.e. the same lane as an auth failure. That set
          // `sawProviderError` (agent-session.ts) → `closure {reason:'abort'}`
          // → seal `failed` with `finalTurnCount: 0`, discarding every
          // accumulated turn of the session (a real incident lost 9 turns /
          // ~2.02M cache-read tokens across five failed resumes).
          //
          // Route it to a CLEAN terminal instead: set the exhaustion flag and
          // break, so the caller commits the accumulated assistant turn and
          // emits `turn.completed` stamped with OVERLOAD_EXHAUSTED. The turn
          // then counts (`turnCount++`), so `afk --resume` restarts from saved
          // state. The failure stays LOUD — the sentinel maps to an `abort`
          // closure and a `failed` seal, exactly like the
          // `tool_use_loop_capped` precedent — it simply stops being lossy.
          // Checked immediately after the retry guard so no other branch can
          // claim the event, and `isOverloadedErrorEvent` is re-tested rather
          // than inferred so a non-overload error still falls through.
          if (isOverloadedErrorEvent(out.event.error) && !input.signal.aborted) {
            overloadExhausted = true;
            break;
          }
          // User interrupt (ESC soft-stop): translate.ts converted the abort
          // throw into this in-band `error` event, but on an interrupt the
          // "error" IS the abort — not a real failure. Do NOT yield it. If we
          // did, the turn would emit TWO terminal events (this error AND the
          // `turn.completed` from the `turnResult === null` path), and a
          // consumer that breaks on the FIRST terminal (AgentSession's
          // sendMessageStreamInternal breaks on `done`|`error`) would strand
          // the trailing turn.completed — the NEXT turn's first pull then eats
          // it as a no-op `done`, so the user's next message runs a full turn
          // late (the "type after ESC → nothing happens → poke '.' to start it"
          // bug). Break WITHOUT yielding + WITHOUT setting translatorErrored so
          // the caller's `turnResult === null` branch emits exactly ONE terminal
          // turn.completed. `sawProviderError` correctly stays false — an
          // interrupt seals as cancelled, not failed. Real (non-abort) errors
          // fall through to the yield below unchanged. Checked before the
          // StreamIncomplete re-drive below so an abort always wins over a retry
          // (that branch also self-guards with `!input.signal.aborted`).
          if (input.signal.aborted) {
            break;
          }
          // Mid-stream CLEAN close (StreamIncompleteError): the stream ended
          // with no message_stop and no stop_reason AFTER content streamed — an
          // intermediary dropped the connection mid-generation. translate.ts
          // surfaces it as this in-band error event (it is constructed and
          // yielded, never thrown, so it cannot reach the catch below). Neither
          // the TTFB branch (a first byte was seen) nor the overload branch (not
          // an overloaded_error) matches it, so without this it would fall
          // through to the fatal path. Re-drive like overload: input.messages is
          // unmutated for the round, so the retry re-sends identical history
          // (already-streamed text may re-emit — reset via stream.retry).
          if (
            out.event.error instanceof StreamIncompleteError &&
            retry.canRetryStreamIncomplete() &&
            !input.signal.aborted
          ) {
            retryStreamIncomplete = true;
            break;
          }
          yield out.event;
          translatorErrored = true;
          break;
        }
        yield out.event;
      } else {
        turnResult = out.result;
        break;
      }
    }
    if (env.AFK_TELEGRAM_TRACE) console.log('[loop] translate loop exited, turnResult=', turnResult ? 'set' : 'null');
  } catch (err) {
    // A TTFB timeout that fires AFTER response headers but BEFORE the first
    // streamed event aborts the stream iterator here. `ttfb.timedOut()` is only
    // true while the timer is live — firstByteSeen() above clears it, so this
    // branch is unreachable once any event has streamed. Re-drive once.
    if (ttfb.timedOut() && !input.signal.aborted && !retry.ttfbRetried && !ttfbEmitted) {
      ttfb.dispose();
      stall.dispose();
      retryTtfb = true;
    } else {
      ttfb.dispose();
      stall.dispose();
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: turn.terminalUsage(),
          sessionId: input.ctx.sessionId,
        };
        return { kind: 'terminated' };
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // Post-first-byte STALL (#762) reaching us as a THROW rather than an
      // in-band error event (abortableStream re-raises the linked signal's
      // abort reason, which for a stall is the STALL_TIMEOUT_MESSAGE marker).
      // Same terminal treatment as the in-band branch above: surface the
      // operator-facing message and return, never hang. Checked BEFORE the
      // overload re-drive so a stall can never be mistaken for a retryable
      // overload.
      if ((stall.timedOut() || isStallTimeoutError(e)) && !input.signal.aborted) {
        yield { type: 'error', error: stallTimeoutError(stallTimeoutMs) };
        return { kind: 'terminated' };
      }
      // Defensive: a mid-stream overload normally reaches us as an in-band
      // error event (handled in the loop above), but if translate.ts ever
      // re-throws one, route it into the same retry path rather than crashing.
      if (isOverloadedErrorEvent(e) && retry.canRetryOverload() && !input.signal.aborted) {
        retryOverload = true;
      } else if (isOverloadedErrorEvent(e) && !input.signal.aborted) {
        // Budget exhausted on the re-thrown path: same non-lossy terminal as
        // the in-band branch above (see the Invariant comment there).
        overloadExhausted = true;
      } else {
        yield { type: 'error', error: e };
        return { kind: 'terminated' };
      }
    }
  }
  // Dispose both stall timers for this round once stream consumption is done
  // (clean end, turn-result, or a retry decision) — idempotent, so the
  // firstByteSeen() / catch-path disposes above are harmless duplicates.
  ttfb.dispose();
  stall.dispose();

  // Invariant: classification order mirrors the pre-split loop's cascade of
  // `if` blocks. Retry classes are checked before terminals (an exhausted round
  // is never also a retried round), and `overload-exhausted` before
  // `translator-errored` so the clean terminal wins over the fatal lane.
  if (retryTtfb) return { kind: 'retry', reason: 'ttfb' };
  if (retryOverload) return { kind: 'retry', reason: 'overload' };
  if (retryStreamIncomplete) return { kind: 'retry', reason: 'stream-incomplete' };
  if (overloadExhausted) return { kind: 'overload-exhausted' };
  if (translatorErrored) return { kind: 'translator-errored' };
  return { kind: 'streamed', turnResult };
}
