/**
 * TTFB (time-to-first-byte) elapsed timer helpers for StreamRenderer.
 *
 * Extracted from stream-renderer-lifecycle.ts to keep that file under the
 * 350-line ceiling. Contains the per-tick TTFB annotation checker that drives
 * the "waiting for response… Ns" progress-banner update at ~1 Hz, and the
 * shared TTFB_GRACE_MS constant.
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
 * Drive the TTFB waiting-line overlay update. Called on every 80ms
 * `checkPauseAnnotations` tick; fires a progress-banner flush at most once per
 * second (change-detection on the annotation string, same pattern as the stall
 * annotation in `checkPauseAnnotations`).
 *
 * Contract: mutates `ctx.lastTtfbAnnotation` when the displayed second
 * advances. The caller (stream-renderer.ts `checkPauseAnnotations`) writes the
 * updated value back to its own instance field so successive ticks see it.
 * This avoids the LifecycleContext snapshot becoming stale between the read
 * and the write-back — the snapshot is rebuilt from instance fields on every
 * tick, so writing to the snapshot's field propagates on write-back.
 *
 * Returns true when a flush was triggered (the caller may discard this).
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
  ctx.overlayComposer.flush();
  return true;
}

/**
 * Clears the TTFB waiting indicator when the first streaming content arrives.
 * Idempotent — repeated calls after the first flip are no-ops.
 * Returns true if a flush was triggered (caller may discard).
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
    overlayComposer.flush();
    return true;
  }
  return false;
}

/**
 * Render the TTFB waiting line for the progress-banner overlay slot, or
 * return `''` when the timer is not active, done, or inside the grace period.
 * Pure (no side effects).
 */
export function renderTtfbWaitingLine(
  getTtfbStartedAt: (() => number | undefined) | undefined,
  isTtfbDone: (() => boolean) | undefined,
  palette: { dim: (s: string) => string },
): string {
  if (!getTtfbStartedAt || !isTtfbDone || isTtfbDone()) return '';
  const startedAt = getTtfbStartedAt();
  if (startedAt === undefined) return '';
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < TTFB_GRACE_MS) return '';
  const secs = Math.floor(elapsedMs / 1000);
  return palette.dim(`  ◦ waiting for response… ${secs}s`);
}
