/**
 * Progress-aware idle watchdog for forked sub-agent turns.
 *
 * Contract: fire when a forked child produces NO observable {@link OutputEvent}
 * for a full idle window — the signal that distinguishes a "healthy child
 * grinding for 40 min" from a "child stalled at minute 2". This is DISTINCT
 * from the blunt wall-clock budget (`SUBAGENT_DEFAULT_TIMEOUT_MS`, 45 min),
 * which bounds total turn TIME regardless of activity: round-caps bound *work
 * done*, wall-clock bounds *time elapsed*, and neither bounds *time since the
 * child last did anything observable*. The two run concurrently — the idle
 * watchdog is the tighter first-to-fire bound; the wall-clock stays as the
 * un-resettable ceiling.
 *
 * Anti-gaming property: the ONLY thing that resets the idle clock is a real
 * {@link OutputEvent} from the provider stream (the SSE→OutputEvent mapping in
 * the loop, not a caller-facing API). There is no standalone
 * heartbeat/keepalive event a wedged child could emit to keep itself alive.
 *
 * Pause-aware (never fires while legitimately waiting on a provider-communicated
 * backoff window): on an OAuth `paused` event (subscription park, ≤2h) or a
 * `rate_limit` event carrying `retryAfterMs`, the deadline is EXTENDED to
 * `now + windowMs + slack` (not merely reset), mirroring the shipping precedent
 * `src/telegram/streaming.ts:374-376`. Only *unexplained* silence counts against
 * the idle budget. On `resumed`, the window collapses back to a normal idle
 * bound.
 *
 * Tool-aware (never fires while a tool is legitimately executing): a forked
 * child's tool call runs SILENTLY between its `tool_use_detail` chunk and its
 * matching `tool_result` chunk — both providers yield every `tool.use.start`,
 * then `await` the tool dispatch with zero intervening events, then yield every
 * `tool.output`. That wait is bounded by the tool's OWN limit (bash ≤10min via
 * `handlers/bash.ts`, a nested `agent` turn by its own wall-clock, a slow
 * network tool by its timeout), so counting it against the idle budget would
 * abort exactly the "healthy child grinding" case this watchdog protects. The
 * idle clock is therefore SUSPENDED while ≥1 tool is in flight and re-armed
 * when the last one returns. A tool that hangs with no bound of its own is
 * still caught by the un-resettable wall-clock ceiling — the same guarantee as
 * before this watchdog existed.
 *
 * On fire the watchdog aborts the SAME `AbortController` `withTimeout` already
 * targets in `SubagentHandleImpl.run`, so the existing `AbortGraph` cascade,
 * own-budget-vs-cascade classification, and partial-output preservation all
 * apply unmodified. Because {@link IdleWatchdogError} extends
 * {@link TimeoutError}, an idle-fire classifies as `failed` (own-budget), not
 * `cancelled`.
 *
 * Timer discipline mirrors {@link armFirstByteTimeout}: a single
 * `setTimeout` that is `.unref()`'d so it never keeps the event loop alive on
 * its own, cleared and re-created on every re-arm, and disposed idempotently on
 * normal completion.
 *
 * @module agent/subagent/idle-watchdog
 */

import { IdleWatchdogError } from '../../utils/errors.js';
import type { OutputEvent } from '../types/session-types.js';

/**
 * Slack added to a recognized pause window (OAuth `paused` / `rate_limit`
 * `retryAfterMs`) before the idle deadline. Guards against the deadline firing
 * the instant a provider says it will resume — the resume + first replayed
 * token needs a moment to actually stream. 30s, matching the spec's proposed
 * OAuth-pause slack (Open Q4) and the order of the Telegram streaming precedent.
 */
export const IDLE_WATCHDOG_PAUSE_SLACK_MS = 30_000;

/**
 * Progress-aware idle watchdog over one forked sub-agent turn.
 *
 * Lifecycle: construct (arms the initial window unless disabled) → call
 * {@link onEvent} for every streamed {@link OutputEvent} (re-arms per the
 * event's semantics) → {@link dispose} on normal completion. When
 * `idleTimeoutMs <= 0` the watchdog is fully disabled (no timer is ever armed
 * and {@link onEvent}/{@link dispose} are no-ops) — the explicit escape hatch,
 * matching every other timeout in the codebase.
 */
export class IdleWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private fired = false;

  /**
   * Tool-use ids currently executing on the child — populated on each
   * `tool_use_detail` chunk and drained on the matching `tool_result`. While
   * non-empty the idle clock is SUSPENDED: a running tool is a bounded wait on
   * the tool's own limit, not unexplained silence. A `Set` (not a counter) so
   * duplicate starts and results-without-starts can never drive it negative.
   */
  private readonly inFlightTools = new Set<string>();

  /**
   * @param controller — the sub-agent's abort controller (the SAME one
   *   `withTimeout` targets). Aborted with an {@link IdleWatchdogError} on fire.
   * @param idleTimeoutMs — the idle window in ms. `<= 0` disables the watchdog.
   * @param label — human-readable identifier (the sub-agent id) woven into the
   *   error message and the fire callback for observability.
   * @param onFire — optional callback invoked exactly once, immediately before
   *   the controller is aborted, carrying the elapsed idle window and the last
   *   observed event type. The handle uses this to emit the
   *   `idle_watchdog_fired` trace phase. Never called when the watchdog is
   *   disabled or disposed. Errors thrown by the callback are swallowed so a
   *   trace-emit failure can never suppress the abort.
   */
  constructor(
    private readonly controller: AbortController,
    private readonly idleTimeoutMs: number,
    private readonly label: string,
    private readonly onFire?: (info: {
      idleTimeoutMs: number;
      elapsedSinceLastProgressMs: number;
      lastEventType: string;
    }) => void,
  ) {
    if (!this.isEnabled()) return;
    // Arm the initial window immediately. `lastEventType` is 'none' until the
    // first event arrives — a stall BEFORE any output (post-first-byte; the TTFB
    // window governs pre-first-byte) still fires correctly, the primary target
    // case (raw TCP stall, no HTTP response).
    this.arm(this.idleTimeoutMs, 'none');
  }

  /** True when a positive idle window is configured (watchdog active). */
  private isEnabled(): boolean {
    return Number.isFinite(this.idleTimeoutMs) && this.idleTimeoutMs > 0;
  }

  /**
   * Feed one streamed {@link OutputEvent}, re-arming (or suspending) the idle
   * deadline per the event's semantics:
   *
   * - `chunk`/`tool_use_detail` (a tool started): SUSPEND the idle clock — the
   *   child is now in a bounded wait on the tool's own limit, not idle. Held
   *   suspended until every in-flight tool reports back.
   * - `chunk`/`tool_result` (a tool finished): re-arm a normal idle window once
   *   the LAST in-flight tool completes (a parallel batch stays suspended until
   *   all of its results arrive).
   * - `paused` (OAuth subscription park): extend to `resetsAt + slack` when a
   *   reset time is known, else a generous fixed park window — the turn is
   *   legitimately waiting, not stalled.
   * - `rate_limit` with `retryAfterMs`: extend to `now + retryAfterMs + slack`.
   *   A `rate_limit` without `retryAfterMs` is treated as ordinary progress
   *   (a plain re-arm) — it still proves the stream is live.
   * - `resumed` and any other event (`chunk`/`content`, `message`, …): ordinary
   *   progress → re-arm at `now + idleTimeoutMs`.
   *
   * No-op when the watchdog is disabled, already disposed, or already fired.
   */
  onEvent(event: OutputEvent): void {
    if (!this.isEnabled() || this.disposed || this.fired) return;

    // Invariant: the idle clock is SUSPENDED while ≥1 tool is in flight. A
    // forked child's tool call runs silently between its `tool_use_detail`
    // chunk (yielded before dispatch) and its matching `tool_result` chunk
    // (yielded after) — both providers yield every start, `await` the dispatch
    // with zero intervening events, then yield every result. That wait is
    // bounded by the tool's own limit (bash ≤10min, a nested `agent` turn by
    // its wall-clock, a network tool by its timeout), so counting it as idle
    // would abort the "healthy child grinding" case this watchdog protects.
    // Suspend on start, re-arm when the last in-flight tool returns; a tool
    // that hangs with no bound of its own stays caught by the wall-clock.
    if (event.type === 'chunk') {
      if (event.chunk.type === 'tool_use_detail') {
        this.inFlightTools.add(event.chunk.toolUseId);
        this.clearTimer(); // a running tool is a bounded wait, not idle
        return;
      }
      if (event.chunk.type === 'tool_result') {
        this.inFlightTools.delete(event.chunk.toolUseId);
        if (this.inFlightTools.size === 0) this.arm(this.idleTimeoutMs, event.chunk.type);
        return;
      }
    }

    // Any other signal while a tool is still executing is part of that bounded
    // wait — leave the suspend intact. (In practice the providers emit none
    // mid-dispatch; this keeps the invariant robust regardless of ordering.)
    if (this.inFlightTools.size > 0) return;

    if (event.type === 'paused') {
      this.arm(this.pausedWindowMs(event.resetsAt), event.type);
      return;
    }
    if (event.type === 'rate_limit') {
      if (typeof event.retryAfterMs === 'number' && event.retryAfterMs > 0) {
        this.arm(event.retryAfterMs + IDLE_WATCHDOG_PAUSE_SLACK_MS, event.type);
        return;
      }
      // A rate_limit with no retryAfterMs is still a live-stream signal; fall
      // through to an ordinary re-arm rather than extending indefinitely.
    }
    // `resumed` and every other event type are ordinary progress: collapse (or
    // stay at) a normal idle window measured from now.
    this.arm(this.idleTimeoutMs, event.type);
  }

  /**
   * Compute the extended window for an OAuth `paused` event. When `resetsAt` is
   * known, extend to `resetsAt - now + slack` (but never below a normal idle
   * window, mirroring `Math.max` in the Telegram streaming precedent). When it
   * is absent (the `oauth-limit-no-ts` case), the provider has not told us when
   * it will resume — fall back to the idle window so the watchdog stays armed
   * with normal cadence rather than parking blind for hours; a genuinely long
   * park will re-arm on the eventual `resumed`/next event, and a wedged one
   * still fires.
   */
  private pausedWindowMs(resetsAt: Date | undefined): number {
    if (resetsAt === undefined) return this.idleTimeoutMs;
    const untilResetMs = resetsAt.getTime() - Date.now();
    return Math.max(this.idleTimeoutMs, untilResetMs + IDLE_WATCHDOG_PAUSE_SLACK_MS);
  }

  /**
   * (Re)arm the timer for `windowMs`, replacing any existing one. Records the
   * arming time + the triggering event type so the fire callback can report how
   * long the stall ran and what the last observed event was. A non-positive
   * `windowMs` is clamped to the idle window so a bogus retry-after can never
   * fire the watchdog instantly.
   */
  private arm(windowMs: number, lastEventType: string): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const effectiveWindowMs = windowMs > 0 ? windowMs : this.idleTimeoutMs;
    const armedAt = Date.now();
    const timer = setTimeout(() => {
      this.fire(Date.now() - armedAt, lastEventType);
    }, effectiveWindowMs);
    // Never keep the event loop alive on the watchdog's account.
    timer.unref();
    this.timer = timer;
  }

  /**
   * Clear any armed timer WITHOUT re-arming — SUSPENDS the watchdog. Used while
   * a tool is in flight (a bounded wait, not idle). Distinct from {@link dispose}:
   * a suspended watchdog is still live and re-arms on the next progress event or
   * tool completion; a disposed one is permanently done.
   */
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Fire: abort the sub-agent's controller with an {@link IdleWatchdogError}.
   * Guarded so it runs at most once. The `onFire` callback (trace emission) is
   * invoked before the abort and its errors are swallowed — a trace-emit
   * failure must never suppress the abort.
   */
  private fire(elapsedSinceLastProgressMs: number, lastEventType: string): void {
    if (this.fired || this.disposed) return;
    this.fired = true;
    this.timer = undefined;

    try {
      this.onFire?.({
        idleTimeoutMs: this.idleTimeoutMs,
        elapsedSinceLastProgressMs,
        lastEventType,
      });
    } catch {
      // Observability is best-effort; the abort below is the load-bearing action.
    }

    if (!this.controller.signal.aborted) {
      this.controller.abort(
        new IdleWatchdogError(
          `subagent ${this.label} idle-watchdog fired: no observable progress ` +
            `for ${this.idleTimeoutMs}ms (last event: ${lastEventType}). The child ` +
            `stream produced no output for the idle window — typically a stalled ` +
            `model call under provider throttling with no detectable backoff bracket. ` +
            `Aborting so partial output (if any) is returned; the parent should ` +
            `retry or fall back.`,
          this.idleTimeoutMs,
        ),
      );
    }
  }

  /**
   * Release the timer on normal completion. Idempotent; safe to call in a
   * `finally`. Does NOT abort the controller — a disposed watchdog simply stops
   * watching.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlightTools.clear();
    this.clearTimer();
  }
}
