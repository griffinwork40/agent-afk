/**
 * Smoke fade: the lightweight, whole-element half of the AFK_SMOKE_TEXT
 * visual hierarchy.
 *
 * Invariant (visual hierarchy): model-generated language (streamed prose)
 * gets the full per-character smoke reveal in `smoke-reveal.ts`. Persistent
 * machine-status UI (tool rows, the `◆ thought for Xs` summary) gets THIS
 * instead: the whole element enters at once and brightens along the SAME
 * smoke tone ramp, with no particle glyph phase, then snaps to its own
 * styling. Status stays legible from its first frame; only prose "writes".
 *
 * Contract (settled state): once an element's fade has elapsed, `fadeLines`
 * leaves its lines untouched, so a settled render is byte-identical to a
 * render with the effect off. During the fade a line's ANSI styling is
 * replaced by one ramp tone, and its visible characters are unchanged, so
 * width and layout never shift.
 *
 * Invariant (frame driver): like `SmokeReveal`, repaints are render-driven.
 * A render that styles a still-fading element arms ONE frame timer, which
 * calls `onFrame` once, and the next render re-arms it only if something is
 * still fading. With every element settled, no timer runs.
 *
 * Callers construct an `ElementFade` only when `isSmokeTextEnabled()` holds,
 * so with the flag off none of this runs and no timer is ever armed.
 *
 * @module cli/smoke-fade
 */

import { stripAnsi } from './display.js';
import { smokeTone } from './smoke-reveal.tones.js';

/** Duration of the whole-element fade. Much shorter than the prose reveal: status must read at once. */
export const FADE_MS = 180;
/** Ramp position of the first frame: the same faint start as a smoke speck. */
export const FADE_FLOOR = 0.12;
/**
 * Ramp position of the last faded frame, just before the element snaps to
 * its own styling. Mid-ramp, not the near-foreground end: most status chrome
 * settles dim, and a fade that overshoots its final color reads as a flash.
 */
export const FADE_CEIL = 0.6;
/** Frame cadence, matching the renderer's default repaint throttle. */
export const FADE_FRAME_MS = 33;

const RESET = '\u001b[0m';

/**
 * Restyle one line at fade progress `p` (0 = first frame, 1 = end of the
 * fade). Blank lines are returned unchanged. Ease-out, so the element is
 * visible from the first frame and decelerates into its settled color.
 */
export function fadeLine(line: string, p: number): string {
  const plain = stripAnsi(line);
  if (plain.trim() === '') return line;
  const clamped = Math.min(1, Math.max(0, p));
  const eased = 1 - (1 - clamped) * (1 - clamped);
  return RESET + smokeTone(FADE_FLOOR + (FADE_CEIL - FADE_FLOOR) * eased)(plain) + RESET;
}

/** Tracks per-element fade births (keyed by a stable id) and drives the frames. */
export class ElementFade {
  private readonly births = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly onFrame: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Fade progress for `key` in [0, 1), or `null` once settled. The first call
   * for a key starts its fade, so an element's fade begins on the first frame
   * that actually renders it. Arms the frame timer while the key is fading.
   */
  progress(key: string): number | null {
    if (this.disposed) return null;
    const t = this.now();
    let birth = this.births.get(key);
    if (birth === undefined) {
      birth = t;
      this.births.set(key, t);
    }
    const p = (t - birth) / FADE_MS;
    if (p >= 1) return null;
    this.armFrame();
    return p;
  }

  /**
   * Restyle `lines[from..]`, the rows of one element, in place while that
   * element is fading. No-op (and no birth recorded) when the element
   * rendered zero rows, so an element that is not visible yet keeps its
   * whole fade for the frame where it first appears.
   */
  fadeLines(key: string, lines: string[], from: number): void {
    if (from >= lines.length) return;
    const p = this.progress(key);
    if (p === null) return;
    for (let i = from; i < lines.length; i++) lines[i] = fadeLine(lines[i] ?? '', p);
  }

  /** Stop the frame driver and forget every element. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.births.clear();
  }

  private armFrame(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.disposed) this.onFrame();
    }, FADE_FRAME_MS);
    this.timer.unref?.();
  }
}
