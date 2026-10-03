/**
 * Outermost iteration wrapper: bounded pause + replay after a 529/503
 * exhausts the in-flight stream retry budget.
 *
 * Mirrors {@link anthropic-direct/query/overload-pause-tier.turnWithOverloadPause}
 * but keyed on an `{ type:'error' }` event whose status is 529 or 503 (the
 * exhaustion signal on this wire) rather than on the `OVERLOAD_EXHAUSTED`
 * sentinel stamped on `turn.completed` by the Anthropic-direct loop.
 *
 * Design constraints satisfied:
 *  - Zero changes to `query.ts` class state or history: this tier sits BELOW
 *    the user-message push and INSIDE the tool-round loop, so it retries only
 *    the model call, not the entire turn.
 *  - Interactive surfaces park up to `OVERLOAD_PAUSE_CEILING_MS`; daemon/cron
 *    default to `0` (fail-fast). `AFK_OVERLOAD_PAUSE_MS` overrides both.
 *  - Abort/close always wins over a pause: an ESC fires the abort path and
 *    returns null (no error event forwarded) so the turn-driver synthesizes an
 *    interrupted terminal via finishTurn — matching driveStream's close contract.
 *  - On ceiling exhaustion the tier ends with a clean `turn.committed` path:
 *    it emits an `assistant.message` notice and returns an `IterationResult`
 *    carrying `finishReason: OVERLOAD_EXHAUSTED` (no tool dispatch). The
 *    caller (turn-driver.ts) then calls `finishTurn`, which stamps the sentinel
 *    on `turn.completed` — identical to the anthropic-direct contract so the
 *    turn commits and `afk --resume` works.
 *  - Daemon/cron surfaces (ceilingMs === 0) still forward the error event so
 *    the turn seals with a visible error (fail-fast policy unchanged).
 *  - The pause emits `overload_pause` and `overload_resume` trace phases,
 *    matching the anthropic-direct counterpart so observers see parity.
 *
 * Implementation note on generator return values: `for await` discards the
 * typed return value of an `AsyncGenerator<T, R>`. We use the explicit
 * generator protocol (`.next()` in a manual loop) throughout this module so
 * the `IterationResult | null` returned by `driveStream` is observable and
 * can be surfaced to the caller.
 *
 * @module agent/providers/openai-compatible/query/overload-pause-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import type { TraceSink } from '../../../trace/index.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import {
  resolveOverloadPauseCeilingMs,
  nextProbeDelayMs,
} from '../../anthropic-direct/overload-pause.js';
import { OVERLOAD_EXHAUSTED } from '../../shared/overload-sentinel.js';
import { getErrorStatus, isOpenAIOverloadError } from './retry.js';
import type { IterationResult } from './stream-drive.js';
import { createStreamState } from '../translate.js';

/** HTTP status codes that indicate server overload on the OpenAI-compatible wire. */
const OVERLOAD_STATUS_CODES = new Set([529, 503]);

/**
 * Operator-facing copy for an exhausted overload on the openai-compatible wire.
 * Emitted as an `assistant.message`, mirroring the anthropic-direct counterpart.
 * Unlike the raw error event, this IS visible to the model on `--resume` because
 * `session/stream-consumer.ts` materializes non-empty `assistant.message` events
 * into `conversationHistory`.
 */
export const OPENAI_COMPAT_OVERLOAD_EXHAUSTED_NOTICE =
  'The provider reported it is overloaded (HTTP 529/503 or an overload error event) and ' +
  "did not recover within this turn's retry budget. This is an upstream capacity event, not an afk error. " +
  'The turn was committed, so the conversation so far is preserved — resume with ' +
  '`afk --resume <sessionId>` to continue from saved state once capacity frees up.';

/**
 * Build a synthetic `IterationResult` that signals ceiling exhaustion to the
 * caller (turn-driver.ts). The caller sees `needsToolDispatch: false` and breaks
 * its loop, then calls `finishTurn` with `accumulatedUsage.stopReason =
 * OVERLOAD_EXHAUSTED` (propagated through `usageFromState`). That causes
 * `turn.completed` to carry the sentinel — identical to the anthropic-direct
 * contract.
 */
function exhaustedIterationResult(): IterationResult {
  const state = createStreamState();
  state.finishReason = OVERLOAD_EXHAUSTED;
  return { state, events: [], text: '', needsToolDispatch: false };
}

/**
 * True when `event` is an error event whose underlying status indicates server
 * overload (529 = Anthropic overloaded, 503 = service unavailable), or a
 * status-less SDK overload throw ({@link isOpenAIOverloadError}). Must accept
 * every error `isRetryableStreamError` retries as an overload, otherwise an
 * overload that exhausts the inline budget would skip this pause tier.
 */
export function isOverloadErrorEvent(event: ProviderEvent): boolean {
  if (event.type !== 'error') return false;
  if (isOpenAIOverloadError(event.error)) return true;
  const status = getErrorStatus(event.error);
  return status !== undefined && OVERLOAD_STATUS_CODES.has(status);
}

/** Context threaded through from `OpenAICompatibleQuery` to the tier. */
export interface OverloadPauseTierContext {
  /** AgentConfig.surface — determines whether to park or fail-fast. */
  surface: string | undefined;
  /** Witness trace writer, passed to `emitSessionPhase` (fire-and-forget). */
  traceWriter: TraceSink | undefined;
  /** Per-turn abort signal; an abort always wins over a pause. */
  signal: AbortSignal;
  /** Session-level liveness check (set true on `close()`). */
  isClosed: () => boolean;
  /** Session id for `stream.retry` events. */
  sessionId: string;
}

/**
 * Wrap one `runIteration` call with an overload-aware pause + replay loop.
 *
 * @param makeIteration Factory that returns a fresh `runIteration` generator.
 *   Called once per attempt (initial + each replay). The factory MUST produce a
 *   NEW generator each time — generators are single-use; reusing one would
 *   yield nothing on subsequent attempts.
 * @param ctx Surface, trace writer, and liveness state from the owning query.
 * @returns The same `IterationResult | null` as the inner `runIteration` on a
 *   clean run or a successful pause+replay. On ceiling exhaustion, yields an
 *   `assistant.message` notice and returns a synthetic `IterationResult` carrying
 *   `finishReason: OVERLOAD_EXHAUSTED` (no tool dispatch) so the turn commits
 *   through the normal finish path. On abort or close, returns null (no error
 *   event forwarded) — matching driveStream's close contract. On a daemon/cron
 *   surface (ceilingMs === 0), forwards the error event and returns null.
 */
export async function* runIterationWithOverloadPause(
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>,
  ctx: OverloadPauseTierContext,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  const ceilingMs = resolveOverloadPauseCeilingMs(ctx.surface);
  // Measured from the first exhaustion, NOT from the turn start — a long turn
  // must not silently consume the operator's pause budget before any probe fires.
  let pauseStartedAt: number | null = null;
  let pauseEmitted = false;

  for (;;) {
    // ── Manual generator protocol: preserves the typed return value ──────────
    // `for await` discards `IterationResult | null` returned by `driveStream`.
    // We use `.next()` explicitly so the `{done:true, value}` step is visible.
    const gen = makeIteration();
    let overloadEvent: ProviderEvent | null = null;
    let returnValue: IterationResult | null = null;

    for (;;) {
      const step = await gen.next();
      if (step.done) {
        returnValue = step.value;
        break;
      }
      const event = step.value;
      if (isOverloadErrorEvent(event)) {
        // Contract: driveStream yields at most one error event as its terminal
        // yield before returning null. Consume the final return step to close
        // the generator cleanly, then break out to the overload handling path.
        const terminal = await gen.next();
        returnValue = terminal.done ? terminal.value : null;
        overloadEvent = event;
        // Generator is exhausted (done step consumed); `return(null)` signals
        // intent to close it and satisfies the gen.return() cleanup contract.
        await gen.return(null);
        break;
      }
      yield event;
    }

    // ── Clean run (no overload error intercepted) ────────────────────────────
    if (overloadEvent === null) {
      if (pauseEmitted && pauseStartedAt !== null) {
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'openai-compat', outcome: 'recovered' },
        });
      }
      return returnValue;
    }

    // ── Close: return null without forwarding the error, matching driveStream's
    //    close contract. Checked BEFORE signal.aborted because close() also sets
    //    signal.aborted — close is the stricter path (session is ending).
    if (ctx.isClosed()) {
      return null;
    }

    // ── Abort (interrupt only, not close): return null without forwarding the
    //    error event — turn-driver.ts synthesizes an interrupted terminal via
    //    finishTurn, so the session seals correctly.
    if (ctx.signal.aborted) {
      return null;
    }

    // ── Fail-fast for daemon/cron (ceilingMs === 0): forward the error event
    //    immediately so the turn seals with a visible error.
    if (ceilingMs === 0) {
      yield overloadEvent;
      return null;
    }

    // ── Ceiling guard ────────────────────────────────────────────────────────
    pauseStartedAt ??= Date.now();
    const remainingMs = ceilingMs - (Date.now() - pauseStartedAt);
    if (remainingMs <= 0) {
      if (pauseEmitted) {
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'openai-compat', outcome: 'ceiling-reached' },
        });
      }
      // Ceiling exhausted: commit the turn through the normal finish path (mirrors
      // anthropic-direct). Emit an operator-facing notice before returning the
      // synthetic IterationResult so turn-driver.ts calls finishTurn with the
      // OVERLOAD_EXHAUSTED stop-reason stamped on the resulting turn.completed.
      yield {
        type: 'assistant.message',
        text: OPENAI_COMPAT_OVERLOAD_EXHAUSTED_NOTICE,
        sessionId: ctx.sessionId,
      };
      return exhaustedIterationResult();
    }

    // ── Emit pause trace on the first overload ───────────────────────────────
    if (!pauseEmitted) {
      void emitSessionPhase(ctx.traceWriter, {
        phase: 'overload_pause',
        metadata: {
          reason: 'overloaded',
          source: 'openai-compat',
          hasResetTimestamp: false,
          ceilingMs,
          surface: ctx.surface ?? 'unknown',
        },
      });
      pauseEmitted = true;
    }

    // ── Jittered probe interval (clamped to remaining budget) ────────────────
    // A 529/503 carries no reset timestamp; the only honest strategy is to
    // re-probe on a jittered interval. Clamped to the remaining ceiling so
    // a 1ms ceiling doesn't still park a full 60s.
    await sleepWithAbort(Math.min(nextProbeDelayMs(), remainingMs), ctx.signal);

    // Re-check abort/close after sleeping — the signal may have fired during
    // the wait. Check isClosed() FIRST: close + abort → close path (stricter).
    // Both paths return null without forwarding the error event.
    if (ctx.isClosed()) { return null; }
    if (ctx.signal.aborted) return null;

    // Tell surfaces to discard the current partial paint before the replay
    // begins from scratch — mirrors `stream.retry` in `turnWithOverloadPause`.
    yield { type: 'stream.retry', sessionId: ctx.sessionId };
    // loop continues → makeIteration() called again
  }
}
