/**
 * Inactivity watchdog and progress-gate timer for the Telegram streaming handler
 *
 * Extracted from `streamResponse` in streaming.ts. `makeNextWithTimeout`
 * wraps a stream iterator with a re-arming inactivity watchdog, and
 * `openProgressGate` handles the one-shot timer that opens the `◦` latency
 * gate when no subsequent progress event arrives in time.
 * @module telegram/streaming.watchdog
 */

import { StreamTimeoutError } from './stream-timeout-error.js';
import type { OutputEvent } from '../agent/types.js';
import {
  TTFB_MAX_ATTEMPTS,
  ttfbAttemptTimeoutMs,
} from '../agent/providers/anthropic-direct/loop/retry-budget.js';
import { resolveTtfbTimeoutMs } from '../agent/providers/shared/first-byte-timeout.js';

/** Max wait for first stream event (e.g. SDK/API cold start) */
export const FIRST_EVENT_TIMEOUT_MS = 90_000;
/**
 * Max wait between subsequent events. The window is re-armed whenever sub-agent
 * progress arrives via the sink (see `lastActivityAt`), so deep sub-agent
 * fan-out — which is silent on the PARENT stream while children run — no longer
 * trips a false timeout. 180s of TOTAL silence (no parent event AND no
 * sub-agent activity) is treated as a genuinely stuck turn.
 */
export const NEXT_EVENT_TIMEOUT_MS = 180_000;

/**
 * Ceiling on how long the inactivity watchdog stays SUSPENDED for in-flight
 * foreground tool calls (see `inFlightTools`). A long foreground tool — a
 * nested `afk chat` via bash, a multi-minute build/test — is silent on the
 * parent stream between its `tool_use_detail` (start) and `tool_result` (end),
 * so counting that silence as a stuck stream is wrong. The bash tool self-caps
 * at 600s (src/agent/tools/handlers/bash.ts), so no single foreground tool call
 * can legitimately exceed this; a tool still in flight past the ceiling is
 * genuinely wedged and the watchdog is allowed to fire.
 */
export const MAX_TOOL_INFLIGHT_MS = 660_000;
/** While suspended for an in-flight tool, re-check the ceiling at this cadence. */
export const TOOL_INFLIGHT_RECHECK_MS = 15_000;

/**
 * Slack added on top of the provider's TTFB worst-case budget so the
 * provider's own retry logic gets a chance to recover before the Telegram
 * watchdog fires a user-visible timeout.
 */
export const API_ROUND_INFLIGHT_HEADROOM_MS = 60_000;

/**
 * Compute the ceiling on how long the watchdog stays SUSPENDED while the
 * provider is making a new `messages.create` API call between tool rounds.
 *
 * Derived at runtime from the live TTFB config so operators who raise
 * `AFK_MODEL_TTFB_TIMEOUT_MS` above the default (180 s) do not find the
 * watchdog firing BEFORE the provider's own retry budget exhausts (issue #1142).
 *
 * Formula: TTFB_MAX_ATTEMPTS × ttfbAttemptTimeoutMs(configured) +
 *          API_ROUND_INFLIGHT_HEADROOM_MS
 *
 * At the default (180 s): 3 × 120 s + 60 s = 420 s — identical to the old
 * hardcoded constant. At an operator-raised 300 s: 3 × 200 s + 60 s = 660 s.
 */
export function computeMaxApiRoundInflightMs(): number {
  return TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(resolveTtfbTimeoutMs()) + API_ROUND_INFLIGHT_HEADROOM_MS;
}

/**
 * Tool-progress (`◦`) lines stay HIDDEN until the turn has been working this
 * long. Most turns finish faster than this and now render no progress noise at
 * all — the live preview goes straight from `Thinking…` to the answer.
 *
 * Withheld lines are still recorded (see `progressEntries`); when the gate opens
 * the rolling region renders the most recent ones, so nothing is lost — it is a
 * render delay, not a drop. Overridable per call via `options.progressDelayMs`
 * (tests pass 0 to assert rendering deterministically).
 */
export const PROGRESS_START_DELAY_MS = 5_000;

/**
 * Mutable watchdog state threaded through the event loop.
 */
export interface WatchdogState {
  receivedAny: boolean;
  timedOut: boolean;
  lastActivityAt: number;
  inFlightTools: Set<string>;
  toolInFlightSince: number | null;
  pausedUntil: Date | null;
  /**
   * Set to `true` when a `progress` event arrives (end of a tool round),
   * signalling that the provider is about to make a new `messages.create` call.
   * Cleared when any subsequent event arrives. While `true`, the watchdog
   * suspends (analogous to tool-in-flight) because the parent stream is
   * legitimately silent during the API call's connection + inference phase.
   */
  apiRoundInFlight: boolean;
  apiRoundSince: number | null;
}

/** Extra slack (ms) added to the timeout deadline while paused. */
export const PAUSE_SLACK_MS = 90_000;

/**
 * Build the `nextWithTimeout` function for one streaming turn. Returns a
 * function that pulls the next event from `iter` while racing against an
 * inactivity watchdog that re-arms from `state.lastActivityAt`.
 *
 * Module-level factory so the watchdog constants and arm() logic are
 * defined once outside `streamResponse` and independently testable.
 */
export function makeNextWithTimeout(
  iter: AsyncIterator<OutputEvent>,
  state: WatchdogState,
): () => Promise<IteratorResult<OutputEvent>> {
  // Resolved once per turn (not per recheck) so a runtime config change mid-
  // turn never produces an inconsistent ceiling. Re-derived on each outer call
  // (i.e. per event pull) which is fine — env reads are cheap and synchronous.
  const maxApiRoundInflightMs = computeMaxApiRoundInflightMs();
  return (): Promise<IteratorResult<OutputEvent>> => {
    // During a usage-limit pause, extend the deadline to reset time + slack
    // so we don't fire a "timed out" error while the provider is waiting.
    const windowMs = state.pausedUntil !== null
      ? Math.max(NEXT_EVENT_TIMEOUT_MS, state.pausedUntil.getTime() - Date.now() + PAUSE_SLACK_MS)
      : (state.receivedAny ? NEXT_EVENT_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS);
    return new Promise<IteratorResult<OutputEvent>>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      // Re-arming watchdog: fire only after `windowMs` of silence measured
      // from the LAST activity. Sub-agent sink events bump `lastActivityAt`,
      // so an active fan-out re-arms the timer instead of tripping a false
      // timeout while the parent stream is legitimately quiet.
      // Contract: combined suspension ceiling
      //
      // The watchdog has THREE independent suspension mechanisms that can
      // overlap, and their ceilings are ADDITIVE rather than unified:
      //
      //   1. pausedUntil (rate-limit pause)
      //      Extends `windowMs` to `(pausedUntil - now) + PAUSE_SLACK_MS`.
      //      Applied at call-site BEFORE arm() is scheduled, so arm() sees
      //      an already-inflated window.
      //
      //   2. inFlightTools (foreground tool call in progress)
      //      Defers the reject inside arm() for up to MAX_TOOL_INFLIGHT_MS
      //      beyond when `remaining` first hits 0.
      //
      //   3. apiRoundInFlight (provider messages.create between tool rounds)
      //      Defers the reject inside arm() for up to maxApiRoundInflightMs
      //      beyond when `remaining` first hits 0.
      //
      // When pausedUntil fires at the same moment apiRoundInFlight is true
      // (e.g. a rate-limit pause arriving while the provider is retrying its
      // next round), the effective worst-case tolerance is:
      //
      //   pause_window + PAUSE_SLACK_MS + maxApiRoundInflightMs
      //   ≈ (pause_window) + 90 s + computeMaxApiRoundInflightMs()
      //
      // where pause_window is provider-governed (typically 60–600 s for
      // Anthropic overload responses). There is no single cap combining
      // all three; this is intentional — each mechanism covers a distinct
      // legitimate silence that could exceed any single unified ceiling on
      // its own. The tradeoff is that a pathological overlap (rate-limit
      // pause + wedged API round) could defer a user-visible timeout by
      // 10+ minutes. If that becomes a problem in practice, gate the
      // apiRoundInFlight branch on `pausedUntil === null` to prevent the
      // additive stack.
      const arm = (): void => {
        const remaining = windowMs - (Date.now() - state.lastActivityAt);
        if (remaining <= 0) {
          // A foreground tool call in flight (a long bash / nested `afk chat`)
          // is silent on the parent stream but is NOT a stuck turn: suspend
          // the watchdog while any tool runs, bounded by MAX_TOOL_INFLIGHT_MS
          // measured from when the first tool started, so a genuinely wedged
          // tool still eventually trips.
          if (
            state.inFlightTools.size > 0 &&
            state.toolInFlightSince !== null &&
            Date.now() - state.toolInFlightSince < MAX_TOOL_INFLIGHT_MS
          ) {
            timeoutId = setTimeout(arm, TOOL_INFLIGHT_RECHECK_MS);
            return;
          }
          // An API round in flight (the provider is calling messages.create
          // between tool rounds) is silent on the parent stream while the
          // model processes the context. Suspend the watchdog like we do for
          // in-flight tools, bounded by maxApiRoundInflightMs so a genuinely
          // wedged API call still eventually trips.
          if (
            state.apiRoundInFlight &&
            state.apiRoundSince !== null &&
            Date.now() - state.apiRoundSince < maxApiRoundInflightMs
          ) {
            timeoutId = setTimeout(arm, TOOL_INFLIGHT_RECHECK_MS);
            return;
          }
          timeoutId = null;
          state.timedOut = true;
          reject(
            new StreamTimeoutError(
              state.receivedAny
                ? 'Response timed out. Try sending a shorter message or try again.'
                : 'Request timed out. The agent may still be starting (first message can take a minute). Try again in a moment.'
            )
          );
        } else {
          timeoutId = setTimeout(arm, remaining);
        }
      };
      timeoutId = setTimeout(arm, windowMs);
      iter.next().then(
        (result) => {
          if (timeoutId != null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          resolve(result as IteratorResult<OutputEvent>);
        },
        (err) => {
          if (timeoutId != null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          reject(err);
        }
      );
    });
  };
}

/**
 * Open the progress-gate timer: fires once after `remainingMs` to flip
 * `progressGateOpen` if no subsequent progress event has already done it.
 *
 * Invariant: the gate must be able to open with NO further stream event.
 * Checking it only on the next `progress` event means one tool that runs
 * silently past the delay leaves the user on `Thinking…` for its entire
 * duration. Arm a one-shot timer for the remaining wait; it is cleared on
 * every terminal path and in the finally.
 *
 * Returns the timer handle so the caller can clear it in `clearProgressTimer`.
 */
export function armProgressGateTimer(
  remainingMs: number,
  onOpen: () => void,
  isTurnEnded: () => boolean,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (isTurnEnded()) return;
    // The onOpen callback gates its own render against editInFlight
    // internally — do NOT gate the gate-open itself, or the progress
    // gate stays permanently closed when an edit is in flight at timer-
    // fire time and no further progress event re-arms it.
    onOpen();
  }, Math.max(0, remainingMs));
}
