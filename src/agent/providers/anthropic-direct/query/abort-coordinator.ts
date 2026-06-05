/**
 * Per-session abort coordination for {@link AnthropicDirectQuery}.
 *
 * Owns the single `AbortController | null` slot that represents "is a turn
 * (or compact) currently in flight?" and the deferred abort reason for the
 * case where `interrupt()` / `close()` arrives between turns (no controller
 * to fire yet). Also owns the `closedPromise` that the outer loop races
 * against `promptStream.next()` so `close()` unblocks a pending pull.
 *
 * # Highest-risk invariant
 *
 * **The current-controller slot must be `null` between turns** so that
 * `compact()`'s `isIdle()` guard does not misclassify a leaked stale
 * controller as `turn-in-flight`. Five sites in the old `query.ts` enforced
 * this with the compare-and-clear pattern:
 *
 *     if (this.abortController === controller) this.abortController = null;
 *
 * After this extraction, **{@link AbortCoordinator.clear} is the only write
 * path to null** — every "end of scope" site calls `clear(controller)` with
 * the controller it received from {@link begin}. The compare-and-clear
 * semantics are preserved: if a parallel scope already replaced the slot,
 * we leave that newer controller in place. The canary test for this
 * invariant is `concurrent-session-isolation.test.ts`.
 *
 * # Pending abort drain
 *
 * `interrupt()` / `close()` can arrive while no controller exists (between
 * turns, or after a turn cleared the slot). Those calls park a
 * `pendingAbortReason`; the next `begin()` immediately drains it onto the
 * fresh controller so the about-to-start work is aborted before its first
 * `await`. The drained reason is then cleared so a subsequent `begin()`
 * does not re-fire.
 *
 * # What this module does NOT own
 *
 * - `state.closed` (the boolean) lives in `SessionState` because sub-
 *   generators read it on every loop iteration. The coordinator only
 *   owns the **promise side** of close — the field and the promise are
 *   updated together by the orchestrator's `close()` method.
 * - Whether to *check* `state.closed` after `await coordinator.<thing>()`
 *   is the caller's job. The coordinator only coordinates abort.
 *
 * @module agent/providers/anthropic-direct/query/abort-coordinator
 */

export type AbortReason = 'interrupted' | 'closed';

/** The sentinel resolved value of `closedPromise`. */
export const CLOSED_SENTINEL = '__closed__' as const;
export type ClosedSentinel = typeof CLOSED_SENTINEL;

/**
 * Encapsulates the per-session abort slot, pending-abort drain, and
 * close-promise. Construct one per session.
 */
export class AbortCoordinator {
  /** The current in-flight controller, or null between turns. */
  private current: AbortController | null = null;

  /**
   * Set by `requestAbort()` when no controller is currently in flight.
   * Drained by the next `begin()` onto the fresh controller and cleared.
   */
  private pendingReason: AbortReason | null = null;

  /**
   * Resolved exactly once by `markClosed()`. The outer loop races this
   * against `promptStream.next()` so `close()` unblocks a pending pull
   * without waiting for the user to send another message.
   */
  readonly closedPromise: Promise<ClosedSentinel>;
  private closeResolve: (() => void) | null = null;

  constructor() {
    this.closedPromise = new Promise<ClosedSentinel>((resolve) => {
      this.closeResolve = (): void => resolve(CLOSED_SENTINEL);
    });
  }

  /**
   * Start a new abort scope. Mints a fresh `AbortController`, installs
   * it as the current slot, and immediately drains any queued
   * `pendingReason` onto it so an abort that arrived between turns
   * fires before the caller's first `await`.
   *
   * The caller must hold the returned controller and pass it back to
   * {@link clear} when the scope ends. Check `controller.signal.aborted`
   * before doing any work — `begin()` may return a pre-aborted controller.
   */
  begin(): AbortController {
    const controller = new AbortController();
    this.current = controller;
    if (this.pendingReason !== null && !controller.signal.aborted) {
      controller.abort(this.pendingReason);
      this.pendingReason = null;
    }
    return controller;
  }

  /**
   * The single write path to null. Compare-and-clear: only nulls the
   * current slot if it still holds `controller`. If a newer `begin()`
   * has already replaced it, the newer controller is preserved.
   *
   * Safe to call multiple times for the same controller — subsequent
   * calls are no-ops after the slot moved on.
   */
  clear(controller: AbortController): void {
    if (this.current === controller) {
      this.current = null;
    }
  }

  /**
   * Abort the in-flight scope if one exists, otherwise park the reason
   * so the next `begin()` drains it onto the fresh controller.
   *
   * No-op when an abort with the same / a different reason is already
   * fired on the current controller — `AbortController.abort()` is
   * itself idempotent. The `!aborted` guard avoids replacing a prior
   * reason on the same signal.
   */
  requestAbort(reason: AbortReason): void {
    const controller = this.current;
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      return;
    }
    this.pendingReason = reason;
  }

  /**
   * True iff no scope is currently in flight. Used by `compact()` to
   * decide whether to return `turn-in-flight` early.
   */
  isIdle(): boolean {
    return this.current === null;
  }

  /**
   * Resolve `closedPromise`. Safe to call multiple times — `Promise`
   * resolution is itself idempotent and `closeResolve` is captured
   * once at construction.
   */
  markClosed(): void {
    this.closeResolve?.();
  }
}
