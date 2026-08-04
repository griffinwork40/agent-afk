/**
 * Inline footer composition — the loop-stage rail and the mascot sprite as
 * FRAME content rather than reserved DECSTBM rows.
 *
 * # Why this module exists
 *
 * Issue #336 shipped the goblin as a constant 3-row right-aligned band living
 * *below* the scroll region, and the loop-stage rail as the topmost reserved
 * row. That layout has two costs the reserved-row model cannot pay off:
 *
 *  1. **The prompt is stranded above its own chrome.** The input line is the
 *     last entry of the compositor frame and the frame is hard-pinned at
 *     `rows - 1 - extraRows`, so every reserved row pushes the prompt UP. The
 *     rail therefore rendered *below* the prompt, and the sprite's three rows
 *     below that — leaving three rows that were blank on the left (the sprite
 *     is right-aligned) directly under the thing the user is typing on.
 *  2. **Two painters, one region.** `MascotBand` erased whole rows (`\x1b[2K`)
 *     on its own 300ms clock while the compositor owned the rows above; any
 *     content sharing a band row was erased three times a second.
 *
 * Compositing both into the frame collapses that: the rail becomes the line
 * directly above the input (so the prompt sits *below* it, not above), and the
 * sprite is overlaid on the right edge of the frame's last rows, flanking the
 * prompt instead of sitting in dead space beneath it. `extraRows` contribution
 * for both drops to zero, which also removes them from the DECSTBM churn that
 * caused the #634/#641 "vanished rail" regressions.
 *
 * Invariant (repaint cadence): this is only sound because the sprite's clock is
 * strictly slower than a clock the compositor already runs. `LiveMascot` ticks
 * at 300ms and ONLY in `working`/`alert`; idle is a still frame with no timer.
 * `SpinnerController` already repaints the frame every 80ms in exactly the
 * `working` state. So folding the sprite into the frame adds no repaint class:
 * at idle it costs nothing, and while working the spinner is already 3.75x
 * faster. Do not port this pattern to a sprite that animates while idle.
 *
 * @module cli/terminal-compositor.footer-inline
 */

import { displayWidth } from './display.js';
import { MINI_MASCOT_WIDTH } from './mascot-mini.js';

/**
 * Columns left blank to the right of the sprite.
 *
 * Invariant (DECAWM): never write the terminal's final column. Writing the
 * last cell of a row arms the pending-wrap flag, and the next write then emits
 * its first character on a NEW line, scrolling the frame. One spare column
 * costs nothing and makes the class of bug impossible. Mirrors the identical
 * guard the reserved band used to hold in `mascot-band.ts`.
 */
export const GUTTER_RIGHT_MARGIN = 1;

/**
 * Minimum display columns of real frame content that must survive to the left
 * of the sprite. Below this the terminal is too narrow to carry both, and a
 * prompt squeezed into a sliver is worse than no goblin.
 */
export const GUTTER_MIN_CONTENT_COLS = 24;

/**
 * Composite `spriteLines` onto the right edge of the LAST `spriteLines.length`
 * entries of `frameLines`.
 *
 * Contract:
 *  - Returns a NEW array; `frameLines` is never mutated.
 *  - Returns the input unchanged (same contents) whenever the sprite cannot be
 *    placed in full. Partial sprites are worse than no sprite — the band this
 *    replaces made the same call in `visibleRows()`, and the reasons are
 *    unchanged: a truncated goblin reads as noise, not as a character.
 *  - Suppresses when ANY target line's content would collide with the gutter,
 *    so a long paste or a wide slash-completion row transiently hides the
 *    sprite rather than overprinting the user's text. It returns on the next
 *    repaint once the line is short again.
 *  - Pads the frame upward with blank lines when it is shorter than the
 *    sprite, but only within `maxLines`; a frame that cannot grow to hold the
 *    sprite suppresses instead. Padding upward (not downward) preserves the
 *    "input is the last frame line" invariant the whole compositor rests on.
 *
 * @param frameLines - Fully composed frame, input line last.
 * @param spriteLines - 0 or {@link MINI_MASCOT_WIDTH}-wide styled rows.
 * @param columns - Terminal width in cells.
 * @param maxLines - Viewport budget the frame may not exceed.
 */
export function overlayMascotGutter(
  frameLines: readonly string[],
  spriteLines: readonly string[],
  columns: number,
  maxLines: number,
): string[] {
  const spriteRows = spriteLines.length;
  if (spriteRows === 0) return [...frameLines];

  // Cells available to frame content before the sprite begins. The sprite then
  // occupies exactly MINI_MASCOT_WIDTH cells ending at `columns - 1`, so the
  // final column is never written (see GUTTER_RIGHT_MARGIN).
  const gutterStart = columns - GUTTER_RIGHT_MARGIN - MINI_MASCOT_WIDTH;
  if (gutterStart < GUTTER_MIN_CONTENT_COLS) return [...frameLines];

  // Grow the frame upward if it is shorter than the sprite (an idle frame is
  // just [rail, input] = 2 lines against a 3-row goblin). Refuse if that would
  // breach the viewport budget.
  const padNeeded = Math.max(0, spriteRows - frameLines.length);
  if (frameLines.length + padNeeded > maxLines) return [...frameLines];
  const padded: string[] = padNeeded > 0
    ? [...Array<string>(padNeeded).fill(''), ...frameLines]
    : [...frameLines];

  const firstTarget = padded.length - spriteRows;

  // Collision pre-check across ALL target rows before mutating any of them:
  // the overlay is all-or-nothing, so a single over-wide row must suppress the
  // whole sprite rather than leave it half-drawn.
  for (let i = 0; i < spriteRows; i++) {
    const line = padded[firstTarget + i] ?? '';
    if (displayWidth(line) > gutterStart) return [...frameLines];
  }

  for (let i = 0; i < spriteRows; i++) {
    const idx = firstTarget + i;
    const line = padded[idx] ?? '';
    const sprite = spriteLines[i];
    if (!sprite) continue;
    const pad = gutterStart - displayWidth(line);
    // Reset before the padding so an unterminated SGR run in the frame line
    // (the caret's inverse-video block is the live example) cannot bleed
    // through the gutter and tint the sprite.
    padded[idx] = `${line}\x1b[0m${' '.repeat(pad)}${sprite}`;
  }

  return padded;
}
