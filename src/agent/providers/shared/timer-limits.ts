/**
 * Platform ceiling for `setTimeout` delays, and the clamp every env-derived
 * duration must pass through before it reaches a timer.
 *
 * Extracted so the two provider stream bounds (`first-byte-timeout.ts`,
 * `stream-stall-timeout.ts`) share one copy of this platform fact rather than
 * duplicating the magic number, and so the remaining unclamped env-derived
 * resolvers (`AFK_SUBAGENT_TIMEOUT_MS`, `AFK_SUBAGENT_IDLE_TIMEOUT_MS`,
 * `AFK_TIMEOUT_MS`) have an obvious import target when they are fixed.
 */

/**
 * Largest delay Node's timer subsystem accepts: 2^31 - 1 ms (~24.8 days).
 *
 * Invariant: a `setTimeout` delay ABOVE this value is not clamped by Node — it
 * is coerced to `1`, emitting a `TimeoutOverflowWarning`, so the timer fires
 * essentially immediately. That inversion is the reason this constant exists:
 * for a stall/timeout bound, "larger than the platform maximum" must degrade to
 * "effectively never" and never to "instantly". Verified on Node v24.11.0 — a
 * delay of 3_000_000_000 fired in 1ms.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Clamp a millisecond delay to {@link MAX_TIMER_DELAY_MS} so an operator who
 * asks for a very large bound gets a very large bound.
 *
 * Contract: only the UPPER end is clamped. `0` (the disable escape hatch shared
 * by the provider bounds) and any other in-range value pass through unchanged,
 * so callers keep full control of their own lower-bound semantics.
 */
export function clampTimerDelayMs(ms: number): number {
  return ms > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : ms;
}
