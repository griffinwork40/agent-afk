/**
 * TTFB (time-to-first-byte) elapsed timer helpers for StreamRenderer.
 *
 * Extracted from stream-renderer-lifecycle.ts to keep that file under the
 * 350-line ceiling. Contains the per-tick TTFB annotation checker
 * (`checkTtfbAnnotation`) and the first-content applier (`applyFirstContent`).
 * The shared `TTFB_GRACE_MS` constant is also exported from here.
 *
 * Invariant: this module has no side effects and no singleton state. All
 * functions are pure or take their mutable state as explicit arguments. The
 * lifecycle context carries the mutable `lastTtfbAnnotation` field; callers
 * write it back after each tick (stream-renderer.ts:checkPauseAnnotations).
 *
 * @module cli/_lib/stream-renderer-ttfb
 */

import type { OverlayComposer } from './overlay-composer.js';

/**
 * Minimum elapsed time before showing the TTFB waiting line, in milliseconds.
 * Matches `ELAPSED_GRACE_MS` in terminal-compositor.scrollback.ts so the
 * waiting line appears at the same threshold as the spinner's elapsed suffix —
 * both start dimming in after 2s of no visible progress.
 */
export const TTFB_GRACE_MS = 2_000;

/**
 * The slice of the lifecycle context that the TTFB tick checker reads and
 * writes. Structural sub-type so callers (stream-renderer.ts) can pass the
 * exact LifecycleContext without a cast.
 */
export interface TtfbTickCtx {
  /**
   * Timestamp at which the current turn started. Set once at arm() from the
   * `turnStartedAt` option; drives the TTFB elapsed waiting line in the
   * progress-banner overlay slot. `undefined` when no turn-start time was
   * supplied (feature disabled).
   */
  ttfbStartedAt: number | undefined;
  /**
   * True once the first streaming content chunk has arrived (TTFB elapsed).
   * Set to false at construction and flipped by `notifyFirstContent()`.
   * The progress-banner slot stops rendering the waiting line once this flips.
   */
  ttfbDone: boolean;
  /**
   * The last TTFB annotation string rendered into the progress-banner slot.
   * Drives 1 Hz change detection in `checkTtfbAnnotation` so the overlay is
   * only re-flushed when the displayed second value changes.
   */
  lastTtfbAnnotation: string;
  isTTY: boolean;
  disposed: boolean;
  overlayComposer: OverlayComposer | null;
}

/**
 * Drive the TTFB overlay update. Called on every 80ms `checkPauseAnnotations`
 * tick; fires a progress-banner flush at most once per second (change-detection
 * on the annotation string, same pattern as the stall annotation in
 * `checkPauseAnnotations`).
 *
 * Contract: mutates `ctx.lastTtfbAnnotation` when the displayed second
 * advances. The caller (stream-renderer.ts `checkPauseAnnotations`) writes
 * the updated value back to its own instance field so successive ticks see it.
 * This avoids the LifecycleContext snapshot becoming stale between the read
 * and the write-back — the snapshot is rebuilt from instance fields on every
 * tick, so writing to the snapshot's fields propagates on write-back.
 *
 * Returns true when the progress-banner was marked dirty (caller must flush).
 */
export function checkTtfbAnnotation(ctx: TtfbTickCtx, now: number): boolean {
  if (
    ctx.disposed ||
    ctx.ttfbDone ||
    ctx.ttfbStartedAt === undefined ||
    !ctx.isTTY ||
    !ctx.overlayComposer
  ) {
    return false;
  }
  const elapsedMs = now - ctx.ttfbStartedAt;
  if (elapsedMs < TTFB_GRACE_MS) return false;

  const secs = Math.floor(elapsedMs / 1000);
  const annotation = `ttfb:${secs}`;
  if (ctx.lastTtfbAnnotation === annotation) return false;

  ctx.lastTtfbAnnotation = annotation;
  ctx.overlayComposer.markDirty('progress-banner');
  // No flush() here — checkPauseAnnotations batches all dirty marks and
  // issues one flush per tick to prevent double-setOverlay compositor desyncs.
  return true;
}

/**
 * Clears the TTFB waiting indicator when the first streaming content arrives.
 * Idempotent — repeated calls after the first flip are no-ops.
 * Returns true if the progress-banner was marked dirty (caller may discard).
 *
 * History: this used to call `overlayComposer.flush()` eagerly, which fired a
 * `setOverlay()` call OUTSIDE the batched 80ms `checkPauseAnnotations` tick.
 * When the tick's own flush landed in the same JS event-loop turn, two
 * `setOverlay()` calls with different overlay heights desynced the compositor's
 * committed-band geometry and produced phantom blank rows in scrollback — the
 * "random large gap" bug. Fixed by removing the eager flush: the dirty mark is
 * picked up by the content event's next overlay repaint. The caller also
 * schedules a zero-delay, post-notification flush: this is required when a
 * block-boundary chunk has already drained the markdown buffer (and therefore
 * its synchronous repaint) before first-content notification runs.
 */
export function applyFirstContent(
  isDone: boolean,
  setDone: () => void,
  overlayComposer: OverlayComposer | null,
): boolean {
  if (isDone) return false;
  setDone();
  if (overlayComposer) {
    overlayComposer.markDirty('progress-banner');
    // No synchronous flush() here. notifyFirstContent queues one in a new
    // event-loop turn, after any repaint triggered by the content chunk. An
    // eager flush could issue a second setOverlay() with a different height in
    // this turn and desync committed-band geometry (phantom blank rows).
    return true;
  }
  return false;
}

