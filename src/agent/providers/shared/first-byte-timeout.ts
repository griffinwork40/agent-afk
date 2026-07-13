/**
 * Time-to-first-byte (TTFB) stall-timeout helper for streaming model calls.
 *
 * Contract: bound how long a single `messages.create({stream:true})` call may
 * stall BEFORE its first streamed event, WITHOUT aborting a slow-but-
 * progressing stream. The caller arms the timer around request creation +
 * first-event consumption, then calls `firstByteSeen()` the instant the first
 * event arrives — from that point the request runs to completion untouched
 * (long opus_1m prefill / extended thinking are never cut off). If the timer
 * fires first it aborts a PER-REQUEST controller (chained to the caller's turn
 * signal via `AbortSignal.any`), so a TTFB timeout never mutates the caller's
 * own signal and stays distinguishable from a user interrupt.
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
