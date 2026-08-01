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
import { clampTimerDelayMs, MAX_TIMER_DELAY_MS } from './timer-limits.js';

/** Default TTFB bound (ms). ~2× the measured p99 ttfb (≈85s) — see issue #583. */
export const DEFAULT_MODEL_TTFB_TIMEOUT_MS = 180_000;

/**
 * Resolve the configured TTFB timeout from `AFK_MODEL_TTFB_TIMEOUT_MS`.
 *
 * Returns the parsed value when it is a finite integer `>= 0`. A value of `0`
 * is the explicit disable escape hatch (returned as `0`). Unset, empty, or
 * unparseable input falls back to {@link DEFAULT_MODEL_TTFB_TIMEOUT_MS};
 * negative values are treated as invalid and also fall back to the default.
 *
 * Values above {@link MAX_TIMER_DELAY_MS} are clamped DOWN to it, because Node
 * coerces an over-ceiling `setTimeout` delay to `1` — so "raise the bound past
 * 2^31-1" would otherwise mean "abort every call almost immediately". Same
 * clamp as `resolveStallTimeoutMs`; see `timer-limits.ts`.
 */
export function resolveTtfbTimeoutMs(): number {
  const raw = env.AFK_MODEL_TTFB_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODEL_TTFB_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MODEL_TTFB_TIMEOUT_MS;
  return clampTimerDelayMs(n);
}

/** Marker error thrown/attached when a request is aborted for a TTFB stall. */
export const TTFB_TIMEOUT_MESSAGE = 'model_ttfb_timeout';

/**
 * Slack added to a provider-communicated throttle window before the TTFB
 * deadline is pushed out. Guards against the deadline firing the instant the
 * provider says it will resume — the resumed request still needs a moment to
 * reach its first token. 30s, deliberately the same value as
 * `PAUSE_WINDOW_SLACK_MS` in `subagent/pause-window.ts`, which solves the
 * identical problem for the forked-subagent idle watchdog. Not imported from
 * there: `providers/` must not depend on `subagent/`.
 */
export const TTFB_THROTTLE_SLACK_MS = 30_000;

/**
 * Invariant: the SDK honors a `retry-after` hint ONLY when
 * `0 <= ms < 60_000`; at or above that it discards the hint entirely.
 * `@anthropic-ai/sdk` 0.74.0 `client.js:412`:
 *
 *     if (!(timeoutMillis && 0 <= timeoutMillis && timeoutMillis < 60 * 1000)) {
 *         timeoutMillis = this.calculateDefaultRetryTimeoutMillis(...);
 *     }
 *
 * Pinned to the locked SDK version. If that guard changes upstream, this
 * constant and {@link SDK_MAX_DEFAULT_BACKOFF_MS} must be re-derived — the
 * accompanying tests assert the arithmetic, not the SDK, so they will NOT catch
 * an upstream drift on their own.
 */
export const SDK_HONORED_RETRY_AFTER_CEILING_MS = 60_000;

/**
 * Ceiling of the SDK's own fallback backoff, used whenever a `retry-after` is
 * discarded per {@link SDK_HONORED_RETRY_AFTER_CEILING_MS}. `client.js:419-428`
 * computes `min(0.5 * 2^n, 8.0)` seconds and then applies 0.75–1.0 jitter, so
 * 8s is the hard maximum. Deliberately the un-jittered ceiling: over-granting by
 * up to 2s is harmless, while under-granting would reintroduce the false
 * positive this whole mechanism exists to remove.
 */
export const SDK_MAX_DEFAULT_BACKOFF_MS = 8_000;

/**
 * Contract: the TTFB extension owed for one provider-communicated throttle, or
 * `undefined` when the provider gave no usable window.
 *
 * Mirrors `pauseWindowMs` semantics on purpose: a throttle WITHOUT a knowable
 * `retry-after` yields `undefined` and the caller keeps its normal bound rather
 * than extending by a guessed amount. The finiteness guard matters because a
 * non-finite delay would re-arm a bogus timer (Node clamps it to 1ms with a
 * TimeoutOverflowWarning), turning an extension into an immediate abort.
 *
 * The extension is derived from the wait the SDK will ACTUALLY take, not from
 * the raw header. Granting the raw value would let a `retry-after: 3600` hint
 * buy an hour of TTFB grace for a park the SDK caps at ~8s — reinstating the
 * unbounded post-connect hang that #583/#762 exist to prevent. Because the
 * honored window is bounded, so is the grace: at most
 * `60s + 30s = 90s` per throttle, and with the SDK's default `maxRetries: 2`
 * (`client.js:72`) at most ~180s per round. The watchdog can be deferred, never
 * disabled.
 */
export function throttleExtensionMs(retryAfterMs: number | undefined): number | undefined {
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return undefined;
  }
  const effectiveWaitMs =
    retryAfterMs < SDK_HONORED_RETRY_AFTER_CEILING_MS ? retryAfterMs : SDK_MAX_DEFAULT_BACKOFF_MS;
  return effectiveWaitMs + TTFB_THROTTLE_SLACK_MS;
}

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
  /**
   * Push the deadline out by `ms` because the provider told us it is parked.
   *
   * Only EXPLAINED waiting is forgiven: the caller passes a window derived from
   * a provider-communicated `retry-after` (see {@link throttleExtensionMs}), so
   * unexplained prefill silence still trips the bound on schedule. No-op once
   * the timer has fired, been disposed, or when the bound is disabled — so a
   * late-draining throttle signal can never resurrect a spent timer.
   */
  extend(ms: number): void;
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
      extend: () => {},
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const linked = AbortSignal.any([baseSignal, controller.signal]);
  let didTimeout = false;
  let disposed = false;
  // Absolute deadline, tracked separately from the live timer so `extend` adds
  // to the ORIGINAL budget rather than restarting a full window from now — two
  // throttles totalling 40s must cost 40s of grace, not two fresh bounds.
  let deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;

  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(TTFB_TIMEOUT_MESSAGE));
    }, clampTimerDelayMs(delayMs));
    timer.unref();
  };
  arm(timeoutMs);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
  };

  const extend = (ms: number): void => {
    if (disposed || didTimeout) return;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
    deadline += ms;
    clearTimeout(timer);
    // Floor at 1ms: a deadline already in the past (a throttle drained after a
    // long park) must still re-arm rather than pass a negative delay, which
    // Node coerces to 1 anyway — being explicit keeps the intent readable.
    arm(Math.max(1, deadline - Date.now()));
  };

  return {
    signal: linked,
    timedOut: () => didTimeout,
    firstByteSeen: dispose,
    extend,
    dispose,
  };
}
