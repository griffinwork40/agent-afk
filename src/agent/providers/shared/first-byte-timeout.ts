/**
 * Time-to-first-byte (TTFB) stall-timeout helper for streaming model calls.
 *
 * Contract: bound how long a single `messages.create({stream:true})` call may
 * stall BEFORE its first streamed CONTENT token — a text/thinking delta or a
 * tool_use start. Connection-level keep-alive (`message_start`, SSE pings) does
 * NOT count: those arrive early on a healthy socket and are consumed without
 * producing a content token, so they cannot be told apart from a genuinely
 * degrading call — and issue #583 targets exactly the latter (a real call slow
 * to its first token, not a throttle). The caller arms the timer around request
 * creation + first-token consumption, then calls `firstByteSeen()` the instant
 * the first content token arrives — from that point the request runs to
 * completion untouched (an actively-streaming extended-thinking response, or a
 * long stream after its first token, is never cut off). CAVEAT: the bound DOES
 * apply to the pre-first-token window, so a prefill whose first token is slower
 * than the bound (e.g. a very large opus_1m context) is treated as a stall —
 * raise `AFK_MODEL_TTFB_TIMEOUT_MS` or set it to 0 for such workloads. If the
 * timer fires first it aborts a PER-REQUEST controller (chained to the caller's
 * turn signal via `AbortSignal.any`), so a TTFB timeout never mutates the
 * caller's own signal and stays distinguishable from a user interrupt.
 *
 * Lives in `shared/` (next to {@link sleepWithAbort}) so the analogous
 * openai-compatible streaming path can reuse the exact same mechanism.
 *
 * @module agent/providers/shared/first-byte-timeout
 */

import { env } from '../../../config/env.js';

/** Default TTFB bound (ms). ~2× the measured p99 ttfb (≈85s) — see issue #583. */
export const DEFAULT_MODEL_TTFB_TIMEOUT_MS = 180_000;

/**
 * Resolve the configured TTFB timeout from `AFK_MODEL_TTFB_TIMEOUT_MS`.
 *
 * Returns the parsed value when it is a finite integer `>= 0`. A value of `0`
 * is the explicit disable escape hatch (returned as `0`). Unset, empty, or
 * unparseable input falls back to {@link DEFAULT_MODEL_TTFB_TIMEOUT_MS};
 * negative values are treated as invalid and also fall back to the default.
 */
export function resolveTtfbTimeoutMs(): number {
  const raw = env.AFK_MODEL_TTFB_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODEL_TTFB_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MODEL_TTFB_TIMEOUT_MS;
  return n;
}

/** Marker error thrown/attached when a request is aborted for a TTFB stall. */
export const TTFB_TIMEOUT_MESSAGE = 'model_ttfb_timeout';

/** Distinguish a TTFB-timeout abort from any other error (e.g. user interrupt). */
export function isTtfbTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message === TTFB_TIMEOUT_MESSAGE;
}

/** Handle returned by {@link armFirstByteTimeout}. */
export interface FirstByteTimeoutHandle {
  /** Signal to pass to `messages.create` — aborts on caller-abort OR TTFB stall. */
  readonly signal: AbortSignal;
  /** True once the TTFB timer has fired (vs. a caller-driven abort). */
  timedOut(): boolean;
  /** Call on the first streamed event: cancels the timer so the stream is unbounded thereafter. */
  firstByteSeen(): void;
  /** Release the timer + listeners. Idempotent; safe to call in a `finally`. */
  dispose(): void;
}

/**
 * Arm a TTFB stall timer over one streaming request.
 *
 * When `timeoutMs <= 0` the timer is disabled and the returned `signal` is the
 * caller's `baseSignal` unchanged (zero behavioural change / full opt-out).
 * Otherwise a per-request `AbortController` is chained to `baseSignal` (so a
 * user interrupt still propagates) and a `setTimeout(timeoutMs)` fires the
 * per-request abort with a {@link TTFB_TIMEOUT_MESSAGE} reason if
 * `firstByteSeen()` has not been called yet. The timer is `.unref()`d so it
 * never keeps the event loop alive on its own.
 */
export function armFirstByteTimeout(
  baseSignal: AbortSignal,
  timeoutMs: number,
): FirstByteTimeoutHandle {
  if (timeoutMs <= 0) {
    return {
      signal: baseSignal,
      timedOut: () => false,
      firstByteSeen: () => {},
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const linked = AbortSignal.any([baseSignal, controller.signal]);
  let didTimeout = false;
  let disposed = false;

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(TTFB_TIMEOUT_MESSAGE));
  }, timeoutMs);
  timer.unref();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
  };

  return {
    signal: linked,
    timedOut: () => didTimeout,
    firstByteSeen: dispose,
    dispose,
  };
}
