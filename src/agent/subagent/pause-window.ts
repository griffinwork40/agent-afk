/**
 * Shared pause-window arithmetic for provider-communicated backoff brackets.
 *
 * Two independent bounds on a forked sub-agent turn need the SAME answer to the
 * same question — "the provider told us it is parked; how long is that park,
 * measured from now?":
 *
 * 1. {@link import('./idle-watchdog.js').IdleWatchdog} — the tighter,
 *    resettable idle bound, which EXTENDS its deadline over a recognized pause
 *    so legitimate waiting never counts as unexplained silence.
 * 2. {@link import('./pause-ceiling.js').PauseAwareCeiling} — the wall-clock
 *    ceiling, which extends by the same window (bounded by an absolute cap) so
 *    a child parked longer than its ceiling is not guaranteed to die.
 *
 * This module is the single source of that arithmetic so the two bounds cannot
 * drift apart. It is deliberately pure: no timers, no state, no I/O — just
 * `OutputEvent` → window ms, so both consumers can unit-test their own policy
 * (floor, cap, re-arm) against a fixed shared primitive.
 *
 * @module agent/subagent/pause-window
 */

import type { OutputEvent } from '../types/session-types.js';

/**
 * Slack added to a recognized pause window before either deadline. Guards
 * against a deadline firing the instant a provider says it will resume — the
 * resume + first replayed token needs a moment to actually stream. 30s, matching
 * the idle watchdog's original constant (spec Open Q4) and the order of the
 * Telegram streaming precedent (`src/telegram/streaming.ts:374-376`).
 */
export const PAUSE_WINDOW_SLACK_MS = 30_000;

/**
 * The provider-communicated pause window for `event`, measured from `now` and
 * including {@link PAUSE_WINDOW_SLACK_MS}; `undefined` when the event is not a
 * pause signal with a knowable window.
 *
 * Recognized signals — and ONLY these two, both originating in the provider's
 * retry layer, never in child-generated content:
 *
 * - `paused` (OAuth subscription park) carrying `resetsAt` → `resetsAt - now + slack`.
 *   The result may be ≤ 0 when the reset time has already passed; callers apply
 *   their own floor (the idle watchdog clamps up to a normal idle window; the
 *   ceiling grants no extension). Deliberately NOT clamped here so neither
 *   caller inherits the other's floor semantics.
 * - `rate_limit` carrying a finite, positive `retryAfterMs` → `retryAfterMs + slack`.
 *
 * A `paused` without `resetsAt` (the `oauth-limit-no-ts` case) returns
 * `undefined`: the provider has not said when it will resume, so there is no
 * window to honor and callers must fall back to their normal bound rather than
 * park blind.
 */
export function pauseWindowMs(event: OutputEvent, now: number = Date.now()): number | undefined {
  if (event.type === 'paused') {
    if (event.resetsAt === undefined) return undefined;
    return event.resetsAt.getTime() - now + PAUSE_WINDOW_SLACK_MS;
  }
  if (event.type === 'rate_limit') {
    const retryAfterMs = event.retryAfterMs;
    // Finiteness guard: a non-finite retry-after would otherwise arm a bogus
    // timer (Node clamps a non-finite delay to 1ms with a TimeoutOverflowWarning).
    // Treated as "no knowable window" so callers use their normal bound.
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return undefined;
    }
    return retryAfterMs + PAUSE_WINDOW_SLACK_MS;
  }
  return undefined;
}

/**
 * One-line human-readable description of a pause signal, for weaving the pause
 * context into a timeout error message so the failure is diagnosable instead of
 * a bare "Operation timed out after 2700000ms". Returns `undefined` for events
 * that are not pause signals.
 */
export function describePauseEvent(event: OutputEvent): string | undefined {
  if (event.type === 'paused') {
    const resetsAt = event.resetsAt !== undefined ? event.resetsAt.toISOString() : 'unknown';
    return `paused (${event.reason}, resetsAt=${resetsAt})`;
  }
  if (event.type === 'rate_limit') {
    const retryAfterMs = event.retryAfterMs;
    return `rate_limit (retryAfterMs=${typeof retryAfterMs === 'number' ? retryAfterMs : 'unknown'})`;
  }
  return undefined;
}
