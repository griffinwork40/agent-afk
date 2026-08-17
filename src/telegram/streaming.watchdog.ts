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
}

/** Extra slack (ms) added to the timeout deadline while paused. */
const PAUSE_SLACK_MS = 90_000;

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
  isEditInFlight: () => boolean,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (isTurnEnded()) return;
    // A render already in flight computed its text before the gate
    // opened; skip rather than racing it — the next event or the final
    // delivery (finalBody, ungated) still surfaces the region.
    if (isEditInFlight()) return;
    onOpen();
  }, Math.max(0, remainingMs));
}
