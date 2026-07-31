/**
 * Pause-aware wall-clock ceiling for forked sub-agent turns.
 *
 * ## Why this exists (revises a shipped decision)
 *
 * `.afk/plans/subagent-idle-watchdog.md:88` locked the wall-clock as the
 * "un-resettable ceiling", and #672 deliberately built pause-awareness into
 * {@link import('./idle-watchdog.js').IdleWatchdog} alone so it would NOT touch
 * `withTimeout`. That split has a fatal consequence, observed in production:
 *
 * A `/forge` fork was dispatched at 02:26:21.307Z with no explicit `timeoutMs`,
 * inheriting `SUBAGENT_DEFAULT_TIMEOUT_MS` (2,700,000 ms). The provider had
 * already parked the account at 01:16:47Z with HTTP 429 `retryAfterMs:
 * 6792000` (`resetsAt: 03:10:00.000Z`, a ~113-minute account-level pause). The
 * child died at 03:11:21.307Z — exactly dispatch + 2,700,000 ms — 81 seconds
 * AFTER the pause reset, losing 1h49m of work. The idle watchdog never fired at
 * its 8-minute window, which proves the runtime recognized the pause and
 * correctly extended the idle deadline. The wall clock ignored the very same
 * signal and killed the child anyway.
 *
 * A fork parked by a provider-imposed pause longer than its ceiling is
 * therefore GUARANTEED to die, no matter what the caller does: the only knob
 * bounds wall time, and callers cannot pre-compute a safe `timeoutMs` because
 * the pause window is unknowable at dispatch. The sole escape is
 * `timeoutMs: 0` (fully unbounded), which is strictly worse.
 *
 * ## What is preserved
 *
 * This honors the PURPOSE of that invariant — a fork's lifetime must have a
 * guaranteed finite, predictable upper bound — rather than its letter:
 *
 * - Extensions are granted ONLY by a provider-reported pause signal (`paused`
 *   with `resetsAt`, `rate_limit` with `retryAfterMs`) — the same events
 *   `IdleWatchdog` already consumes, originating in the provider retry layer.
 *   Child-generated content, token output, thinking, and tool activity NEVER
 *   extend the ceiling. It remains un-resettable by the child: the child cannot
 *   author the only signal that moves it.
 * - Each grant is bounded by the known pause window (via the shared
 *   {@link pauseWindowMs} arithmetic, including its slack), never open-ended.
 * - Total accumulated extension is bounded by
 *   {@link SUBAGENT_MAX_PAUSE_EXTENSION_MS}. Once exhausted the ceiling fires
 *   exactly as it does today. Worst-case lifetime stays finite and predictable:
 *   `timeoutMs + SUBAGENT_MAX_PAUSE_EXTENSION_MS`.
 * - With no pause events the object never grants anything, so default behaviour
 *   is byte-for-byte unchanged.
 *
 * @module agent/subagent/pause-ceiling
 */

import type { TimeoutExtender } from '../timeout.js';
import type { OutputEvent } from '../types/session-types.js';
import { describePauseEvent, pauseWindowMs } from './pause-window.js';

/**
 * Absolute cap on the TOTAL extension a single forked turn's wall-clock ceiling
 * may accumulate from provider pause signals, across all pauses.
 *
 * 2 hours. Rationale: the OAuth subscription park this is defending against is
 * itself bounded — a usage-limit window resets on a ≤2h cadence (see
 * `.afk/plans/subagent-idle-watchdog.md:64`, "subscription park, ≤2h"), and the
 * real incident that motivated this change was a ~113-minute (1h53m) park, which
 * 2h covers with ~7 minutes of headroom. Choosing the provider's own maximum
 * park as the cap means a legitimately parked child survives any pause the
 * provider can impose, while a child parked by anything ELSE (a lying or looping
 * pause signal) is still bounded.
 *
 * Worst-case fork lifetime with the default 45-minute budget is therefore
 * 45min + 2h = 2h45m — finite, predictable, and reached only when a provider
 * actively reports being parked for that entire span.
 */
export const SUBAGENT_MAX_PAUSE_EXTENSION_MS = 2 * 60 * 60_000;

/**
 * Minimum size of a single granted extension. Prevents a pathological re-arm
 * cadence: without a floor, a deadline landing ~1ms after a pause opens would
 * grant ~1ms at a time and re-arm the timer millions of times across a long
 * park. Purely a timer-efficiency guard — it never lets total extension exceed
 * {@link SUBAGENT_MAX_PAUSE_EXTENSION_MS}, so the finite worst-case bound is
 * unchanged.
 */
const MIN_EXTENSION_GRANT_MS = 1_000;

/**
 * Wall-clock ceiling extender driven exclusively by provider pause signals.
 *
 * ## Semantics: the budget bounds WORKING time, not wall time
 *
 * The knob callers have always wanted — and the one the incident proves is
 * missing — is "bound the child's *working* time". This class provides exactly
 * that by CREDITING provider-parked time back to the budget:
 *
 *     effective ceiling = timeoutMs + min(total provider-parked time, cap)
 *
 * Crediting (rather than merely asking "is a pause in effect right now?") is
 * load-bearing. In the real incident the park ended at 03:10:00Z and the
 * deadline landed at 03:11:21.307Z — 81 seconds LATER. A right-now check grants
 * nothing at that instant and the child dies exactly as before, having spent
 * 43m38s of its 45-minute budget parked and getting 81 seconds of actual work.
 * Crediting the parked time returns those ~44 minutes, so the child gets a full
 * budget of real working time.
 *
 * Only the provider's OWN reported window is creditable, and only up to
 * {@link SUBAGENT_MAX_PAUSE_EXTENSION_MS} in total, so the bound stays finite:
 * worst case `timeoutMs + SUBAGENT_MAX_PAUSE_EXTENSION_MS`.
 *
 * Lifecycle: construct → pass as `WithTimeoutOptions.extender` → feed every
 * streamed {@link OutputEvent} to {@link onEvent} → `withTimeout` calls
 * {@link onDeadline} when its deadline is reached, which either grants a bounded
 * extension (re-arming the ceiling) or returns `0` to let it fire.
 *
 * Not a timer: this object holds only the pause bookkeeping. `withTimeout` owns
 * the single timer, exactly as before.
 */
export class PauseAwareCeiling implements TimeoutExtender {
  /**
   * Wall-clock ms timestamp at which the currently-open pause began, or
   * `undefined` when no pause is open. Anchors the credit accrued by the pause
   * in flight; cleared (after finalizing its credit) on `resumed`.
   */
  private pauseStartedAtMs: number | undefined;

  /**
   * Maximum creditable duration of the currently-open pause — the provider's own
   * reported window (+ slack). Credit for that pause never exceeds this, so a
   * park that is signaled and then never resumed cannot accrue credit forever
   * (requirement: each extension is bounded by the known pause window).
   */
  private pauseWindowCapMs = 0;

  /** Credit from pauses that have already closed (`resumed`), in ms. */
  private closedCreditMs = 0;

  /** Human-readable description of the most recent pause signal, for the error message. */
  private lastPauseDescription: string | undefined;

  /** Total extension granted so far, in ms. Monotonically increasing, capped. */
  private grantedMs = 0;

  /** Number of separate extensions granted (diagnostics only). */
  private grantCount = 0;

  /**
   * @param baseTimeoutMs — the fork's configured wall-clock budget, echoed into
   *   the error message so the base budget and the granted extension are
   *   separately legible.
   * @param maxExtensionMs — absolute cap on total accumulated extension.
   *   Defaults to {@link SUBAGENT_MAX_PAUSE_EXTENSION_MS}; a non-positive value
   *   disables extension entirely (the pre-change behaviour).
   */
  constructor(
    private readonly baseTimeoutMs: number,
    private readonly maxExtensionMs: number = SUBAGENT_MAX_PAUSE_EXTENSION_MS,
  ) {}

  /**
   * Feed one streamed {@link OutputEvent}.
   *
   * Only three event types are meaningful, all provider-authored:
   * - `paused` with `resetsAt` / `rate_limit` with `retryAfterMs` → record the
   *   pause window (the deadline is NOT moved here; the extension is granted
   *   lazily at {@link onDeadline}, so a pause that ends before the ceiling is
   *   reached costs nothing).
   * - `resumed` → the park is over; clear it so no further extension is granted.
   *
   * Every other event — `chunk` (content, thinking, tool_use_detail,
   * tool_result), `message`, `progress`, `done`, … — is ignored outright. This
   * is the anti-gaming property: a child cannot extend its own ceiling by
   * producing output or running tools.
   */
  onEvent(event: OutputEvent): void {
    if (event.type === 'resumed') {
      // The park is over: bank its credit and close it. Banking (rather than
      // discarding) is the point — the time the child spent parked was never
      // working time, so it is owed back even though the pause has ended.
      this.closePause();
      return;
    }
    if (event.type !== 'paused' && event.type !== 'rate_limit') return;

    // Self-close an expired pause before recording a new one. `resumed` is
    // emitted ONLY on the OAuth park path (`retry-layer.ts:415,512`); a
    // transient `rate_limit` NEVER has a matching `resumed`. Without this, a
    // rate_limit pause would stay open forever and each later signal would
    // widen its window by the elapsed gap (`elapsedIntoPause + windowMs`),
    // crediting ordinary WORKING time 1:1 — e.g. a 5s retry-after seen every
    // 10 min would credit the full 10 min. A pause is therefore closed as soon
    // as its OWN reported window has elapsed, so credit can only ever reflect
    // time the provider actually said it was parked.
    this.closeExpiredPause();

    const windowMs = pauseWindowMs(event);
    if (windowMs === undefined || windowMs <= 0) {
      // A pause with no knowable window (`oauth-limit-no-ts`, or a
      // `rate_limit` with no usable `retryAfterMs`) grants nothing: an
      // open-ended extension is exactly what this design forbids. The idle
      // watchdog still governs that silence on its normal cadence.
      return;
    }

    const now = Date.now();
    if (this.pauseStartedAtMs === undefined) {
      this.pauseStartedAtMs = now;
      this.pauseWindowCapMs = windowMs;
    } else {
      // Overlapping signals (a transient `rate_limit` during an OAuth park):
      // keep the furthest-out reported end so a short signal can never shorten
      // an already-reported longer park.
      const elapsedIntoPause = now - this.pauseStartedAtMs;
      this.pauseWindowCapMs = Math.max(this.pauseWindowCapMs, elapsedIntoPause + windowMs);
    }
    this.lastPauseDescription = describePauseEvent(event);
  }

  /**
   * Creditable ms accrued by the pause currently open — elapsed time since it
   * began, clamped to the provider's reported window so an unresumed park stops
   * accruing at its stated end. `0` when no pause is open.
   */
  private openPauseCreditMs(): number {
    if (this.pauseStartedAtMs === undefined) return 0;
    const elapsed = Date.now() - this.pauseStartedAtMs;
    return Math.max(0, Math.min(elapsed, this.pauseWindowCapMs));
  }

  /** Bank the open pause's credit and close it. No-op when none is open. */
  private closePause(): void {
    if (this.pauseStartedAtMs === undefined) return;
    this.closedCreditMs += this.openPauseCreditMs();
    this.pauseStartedAtMs = undefined;
    this.pauseWindowCapMs = 0;
  }

  /**
   * Close the open pause if its provider-reported window has already elapsed.
   * Keeps an unresumed pause (every `rate_limit`, and an OAuth park whose
   * `resumed` never arrives) from accruing beyond what the provider stated, and
   * prevents a later signal from retroactively widening a stale window.
   */
  private closeExpiredPause(): void {
    if (this.pauseStartedAtMs === undefined) return;
    if (Date.now() - this.pauseStartedAtMs >= this.pauseWindowCapMs) this.closePause();
  }

  /**
   * Called by `withTimeout` when the ceiling deadline is reached. Returns the ms
   * to extend by, or `0` to let the timeout fire.
   *
   * Grants the provider-parked time not yet credited, capped by the remaining
   * absolute allowance: `min(totalCredit - alreadyGranted, cap - alreadyGranted)`.
   * Time the child spent parked is thereby returned to it as working time —
   * including for a pause that has already CLOSED before the deadline was
   * reached, which is precisely the incident shape (park ended 81s before the
   * deadline).
   *
   * Termination: `grantedMs` is monotonically increasing and bounded by
   * `maxExtensionMs`, and credit only accrues while a provider says it is
   * parked, so the re-arm loop always terminates.
   */
  onDeadline(): number {
    const remainingCapMs = this.maxExtensionMs - this.grantedMs;
    if (!(remainingCapMs > 0)) return 0; // cap exhausted → fire as before

    this.closeExpiredPause();

    const totalCreditMs = this.closedCreditMs + this.openPauseCreditMs();
    const uncreditedMs = totalCreditMs - this.grantedMs;
    if (uncreditedMs <= 0) return 0; // no parked time owed → fire as before

    // Floor each grant so a deadline landing a hair after a pause opens cannot
    // produce a long run of ~1ms re-arms (millions of timer wakeups). Never
    // exceeds the remaining cap, so the finite worst-case bound is unaffected.
    const grantMs = Math.min(Math.max(uncreditedMs, MIN_EXTENSION_GRANT_MS), remainingCapMs);
    this.grantedMs += grantMs;
    this.grantCount += 1;
    return grantMs;
  }

  /**
   * Pause context appended to the {@link TimeoutError} message when the ceiling
   * finally fires, so the failure is diagnosable instead of a bare "Operation
   * timed out after 2700000ms". `undefined` when no pause was ever observed, which
   * keeps the no-pause error message byte-for-byte identical to today's.
   */
  describe(): string | undefined {
    if (this.lastPauseDescription === undefined) return undefined;

    const parts = [
      `base budget ${this.baseTimeoutMs}ms`,
      `pause extension granted ${this.grantedMs}ms across ${this.grantCount} ` +
        `extension${this.grantCount === 1 ? '' : 's'} (cap ${this.maxExtensionMs}ms` +
        `${this.grantedMs >= this.maxExtensionMs ? ', EXHAUSTED' : ''})`,
      `last provider pause: ${this.lastPauseDescription}`,
    ];
    if (this.pauseStartedAtMs !== undefined) {
      const elapsed = Date.now() - this.pauseStartedAtMs;
      const state = elapsed >= this.pauseWindowCapMs ? 'expired' : 'still open';
      parts.push(
        `last pause ${state}, opened ${new Date(this.pauseStartedAtMs).toISOString()} ` +
          `(reported window ${this.pauseWindowCapMs}ms)`,
      );
    }
    return `[pause-aware ceiling: ${parts.join('; ')}]`;
  }

  /** Total extension granted so far (ms). Diagnostics/tests. */
  get totalGrantedMs(): number {
    return this.grantedMs;
  }
}
