/**
 * Steady frame clock for the pending-overlay reveal animation.
 *
 * Invariant (one paint per period, on a fixed grid): while running, the
 * clock fires at `start + n * periodMs` for n = 1, 2, ... Each tick is aimed
 * at its grid time from the ABSOLUTE start (not "previous tick + period"), so
 * timer lateness never accumulates into drift. If the event loop was blocked
 * past one or more grid points, the missed ticks are skipped rather than
 * replayed back-to-back: at most one paint per period, ever.
 *
 * Invariant (dirty-only painting): `markDirty()` never paints; it only
 * records that the next tick must. Content pushes therefore can neither
 * delay a frame nor add a second paint inside a period. A tick with nothing
 * dirty stops the clock (the one timer is released), so an idle, settled
 * reveal costs nothing. The paint callback may call `markDirty()` itself to
 * keep the clock running for the next frame; that is how an animation that
 * is still settling asks for another frame.
 *
 * @module cli/markdown-stream.frame-clock
 */

/** 60 fps. */
export const FRAME_PERIOD_MS = 1000 / 60;

export interface FrameClockOptions {
  periodMs?: number;
  /** Time source for grid alignment. Must advance with the timers (Date.now under fake timers). */
  now?: () => number;
}

export class FrameClock {
  private readonly periodMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private start = 0;
  /** Index of the next grid tick. */
  private n = 0;
  private dirty = false;

  constructor(private readonly paint: () => void, opts: FrameClockOptions = {}) {
    this.periodMs = opts.periodMs ?? FRAME_PERIOD_MS;
    this.now = opts.now ?? Date.now;
  }

  /** True while the clock holds a pending tick. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Request a paint on the next tick, starting the clock if it is idle. */
  markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.start = this.now();
    this.n = 1;
    this.arm();
  }

  /** Cancel the pending tick and forget the dirty flag. Safe to call repeatedly. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }

  private arm(): void {
    const delay = Math.max(0, this.start + this.n * this.periodMs - this.now());
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    // Next grid point at least half a period away. That skips grid points
    // the event loop already overran (never a burst of catch-up paints), and
    // a late tick that lands just shy of a grid point cannot schedule that
    // point a fraction of a millisecond later (a double paint).
    const elapsed = this.now() - this.start;
    this.n = Math.max(this.n + 1, Math.ceil(elapsed / this.periodMs + 0.5));
    if (!this.dirty) return;
    this.dirty = false;
    // Arm BEFORE painting, and keep the tick even if the paint asks for
    // nothing: a push that lands before the next grid point then paints ON
    // the grid instead of restarting it. The next clean tick releases it.
    this.arm();
    this.paint();
  }
}
