/**
 * Progress-aware stall watchdog for the POST-first-byte phase of a streaming
 * model call.
 *
 * Contract: fire when a stream that HAS already produced a first content token
 * then goes fully silent for a whole window — the signal that distinguishes a
 * "legitimately long, actively-streaming round" (a big code emission, extended
 * thinking) from a "stream wedged mid-flight". The ONLY thing that resets the
 * clock is a real translated output event, so a round making observable
 * progress survives indefinitely while a round producing nothing dies loudly.
 *
 * Why this is NOT an absolute per-round wall-clock cap: `armFirstByteTimeout`'s
 * companion invariant (pinned by `loop.ttfb.test.ts`, "does NOT abort a stream
 * that yields a first byte within the bound, even if it then runs long") is
 * deliberate and correct — killing a healthy long round is a regression, not a
 * fix. Slow is legal; stalled is not. A total-duration bound cannot tell them
 * apart; a reset-on-progress bound can.
 *
 * Complements {@link armFirstByteTimeout} rather than replacing it — the two
 * cover disjoint phases of one request and are deliberately separate bounds:
 *
 *   |<-- TTFB bound (pre-first-token) -->|<-- stall window (per silent gap) -->|
 *   request created            first content token            ...tokens...  end
 *
 * The TTFB bound is a ONE-SHOT deadline on the prefill (it retries once, then
 * errors); this is a SLIDING deadline re-armed by every token. Before the first
 * token this watchdog is DORMANT — it arms lazily on the first {@link
 * StreamStallHandle.progress} call — so it can never perturb the pre-first-byte
 * semantics the TTFB tests pin, and it still governs the post-first-byte phase
 * when the TTFB bound is disabled with `AFK_MODEL_TTFB_TIMEOUT_MS=0`.
 *
 * Abort discipline mirrors {@link armFirstByteTimeout} exactly: on fire it
 * aborts a PER-REQUEST controller chained to the caller's turn signal via
 * `AbortSignal.any`, so a stall abort never mutates the caller's own signal and
 * stays distinguishable from a user interrupt (`input.signal.aborted` is the
 * loop's interrupt test, and it must remain false for a stall). The SDK's SSE
 * iterator rejects on that abort, `translate.ts` converts the throw into an
 * in-band `error` event, and the loop's error branch surfaces it as a real
 * terminal `error` — which is the whole point: the round must END, loudly.
 *
 * History: issue #762. Two real sessions (`0f2bcdd0-…`, `4f37526f-…`) ran 38.9
 * and 63.5 minutes after a mid-stream overload burned its retry budget, then
 * sealed `{status:'failed', finalTurnCount:0, incomplete:true}` with NO
 * `loop_end` and NO `closure` event — `incomplete:true` is written only by
 * `TraceWriter.sealOnProcessExit()`, so those turns never returned at all. The
 * cause: the TTFB retry is gated `!ttfbEmitted`, so a single content token
 * cleared every bound for the rest of the round. This module restores a bound
 * over that window without capping healthy rounds.
 *
 * Mechanism and trace vocabulary mirror `subagent/idle-watchdog.ts` (the
 * shipping progress-aware idle watchdog for forked sub-agent turns), which is
 * the precedent for reset-on-progress + `.unref()`'d single timer + `<= 0`
 * disables + an `onFire` hook that emits the `idle_watchdog_fired` phase. It is
 * mirrored rather than reused because that class is bound to three things this
 * phase does not have: it consumes session-level `OutputEvent`s (this sees raw
 * translated provider output), it aborts the sub-agent's OWN controller (this
 * must abort a per-request controller so a stall stays distinguishable from an
 * interrupt), and its tool-in-flight suspend logic is dead weight here (tool
 * dispatch happens strictly AFTER the stream loop closes, so no tool can ever
 * be in flight during the window this watchdog guards).
 *
 * @module agent/providers/shared/stream-stall-timeout
 */

import { env } from '../../../config/env.js';

/**
 * Default post-first-byte stall window (ms).
 *
 * Empirically derived from 12,381 witness traces under `~/.afk/state/witness/`
 * (712,701 events), measuring the POST-first-byte stream phase as
 * `model_ttfb` → the round's first `tool_call` event. That span contains the
 * whole streamed response and NO tool-execution time (tools dispatch only after
 * the stream loop closes), so it is a strict upper bound on any single silent
 * gap inside those rounds — the quantity this watchdog actually measures.
 *
 *   n = 86,076 rounds
 *   p50    =      3,309 ms
 *   p95    =     61,021 ms
 *   p99    =    121,777 ms
 *   p99.9  =    233,734 ms
 *   max    =  1,111,064 ms  (18.5 min — a real, healthy, progressing round)
 *
 * 20 minutes sits above the observed maximum TOTAL stream duration, so no
 * historical round could have tripped it even if it had spent its entire
 * duration in one silent gap (≈9.9× p99.9, ≈5.1× the `loop_end`-derived p99).
 * It is also far below the 38.9 / 63.5-minute hangs of issue #762, so the
 * defect is bounded. Raise it (or set `0`) for workloads that legitimately
 * stall longer than this between tokens.
 */
export const DEFAULT_MODEL_STALL_TIMEOUT_MS = 1_200_000;

/**
 * Resolve the configured stall window from `AFK_MODEL_STALL_TIMEOUT_MS`.
 *
 * Returns the parsed value when it is a finite integer `>= 0`. A value of `0`
 * is the explicit disable escape hatch (returned as `0`), matching the
 * `AFK_MODEL_TTFB_TIMEOUT_MS` convention. Unset, empty, or unparseable input
 * falls back to {@link DEFAULT_MODEL_STALL_TIMEOUT_MS}; negative values are
 * treated as invalid and also fall back to the default.
 */
export function resolveStallTimeoutMs(): number {
  const raw = env.AFK_MODEL_STALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODEL_STALL_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MODEL_STALL_TIMEOUT_MS;
  return n;
}

/** Marker error thrown/attached when a request is aborted for a mid-stream stall. */
export const STALL_TIMEOUT_MESSAGE = 'model_stream_stall_timeout';

/** Distinguish a stall-timeout abort from any other error (e.g. user interrupt). */
export function isStallTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message === STALL_TIMEOUT_MESSAGE;
}

/**
 * Build the operator-facing error for a fired stall watchdog. Names the window,
 * the elapsed silence, and the escape hatch — a stall that surfaces as a bare
 * "aborted" is the failure mode issue #762 is about.
 */
export function stallTimeoutError(timeoutMs: number): Error {
  return new Error(
    `Model stream stalled: no output for ${Math.round(timeoutMs / 1000)}s after ` +
      `the response had already started streaming. The round was aborted rather ` +
      `than left hanging (issue #762: two sessions hung 38 and 63 minutes with no ` +
      `terminal event). A round that keeps producing output is never cut off, no ` +
      `matter how long it runs. Raise AFK_MODEL_STALL_TIMEOUT_MS, or set it to 0 ` +
      `to disable this bound.`,
  );
}

/** Handle returned by {@link armStreamStallWatchdog}. */
export interface StreamStallHandle {
  /** Signal to pass to `messages.create` — aborts on caller-abort OR a stall. */
  readonly signal: AbortSignal;
  /** True once the stall timer has fired (vs. a caller-driven abort). */
  timedOut(): boolean;
  /**
   * Record one observable output event: arms the watchdog on the first call and
   * re-arms the window on every subsequent call. Until the first call the
   * watchdog is dormant (the pre-first-byte window belongs to the TTFB bound).
   */
  progress(): void;
  /** Release the timer + listeners. Idempotent; safe to call in a `finally`. */
  dispose(): void;
}

/**
 * Arm a progress-aware stall watchdog over one streaming request.
 *
 * When `timeoutMs <= 0` the watchdog is disabled and the returned `signal` is
 * the caller's `baseSignal` unchanged (zero behavioural change / full opt-out),
 * matching {@link armFirstByteTimeout}. Otherwise a per-request
 * `AbortController` is chained to `baseSignal` (so a user interrupt still
 * propagates) and each {@link StreamStallHandle.progress} call (re)arms a
 * `setTimeout(timeoutMs)` that aborts the per-request controller with a
 * {@link STALL_TIMEOUT_MESSAGE} reason. The timer is `.unref()`d so it never
 * keeps the event loop alive on its own.
 *
 * @param onFire — optional callback invoked exactly once, immediately before the
 *   controller is aborted, carrying the configured window and the elapsed
 *   silence. Callers use it to emit the `idle_watchdog_fired` trace phase.
 *   Errors thrown by the callback are swallowed so a trace-emit failure can
 *   never suppress the abort.
 */
export function armStreamStallWatchdog(
  baseSignal: AbortSignal,
  timeoutMs: number,
  onFire?: (info: { stallTimeoutMs: number; elapsedSinceLastProgressMs: number }) => void,
): StreamStallHandle {
  if (timeoutMs <= 0) {
    return {
      signal: baseSignal,
      timedOut: () => false,
      progress: () => {},
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const linked = AbortSignal.any([baseSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  let disposed = false;

  const fire = (armedAt: number): void => {
    if (disposed || didTimeout) return;
    didTimeout = true;
    timer = undefined;
    try {
      onFire?.({
        stallTimeoutMs: timeoutMs,
        elapsedSinceLastProgressMs: Date.now() - armedAt,
      });
    } catch {
      // Observability is best-effort; the abort below is the load-bearing action.
    }
    if (!controller.signal.aborted) {
      controller.abort(new Error(STALL_TIMEOUT_MESSAGE));
    }
  };

  const progress = (): void => {
    if (disposed || didTimeout) return;
    if (timer !== undefined) clearTimeout(timer);
    const armedAt = Date.now();
    const t = setTimeout(() => fire(armedAt), timeoutMs);
    // Never keep the event loop alive on the watchdog's account.
    t.unref();
    timer = t;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    signal: linked,
    timedOut: () => didTimeout,
    progress,
    dispose,
  };
}
