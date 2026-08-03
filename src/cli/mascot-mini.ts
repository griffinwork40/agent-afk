/**
 * The live mini-mascot — a one-row goblin head that rides the loop-stage rail.
 *
 * The banner goblin in `mascot.ts` is a 27×13 portrait: far too tall to live
 * on-screen during a turn. This module carries its compact cousin — the same
 * palette, the same half-block renderer (`renderHalfBlockGrid`), the same
 * fallback ladder — sized to be a right-edge *decoration* on a footer row that
 * already exists, rather than a band of its own.
 *
 * The single character row is the load-bearing constraint, not a style choice.
 * A multi-row sprite has to reserve rows, and a reservation that comes and goes
 * with tool activity makes the transcript jump every time the agent picks up a
 * tool. One row fits inside the loop-stage rail (`LiveMascot` hands this sprite
 * to `LoopStageBar` as a right-aligned suffix), so an enabled mascot changes no
 * geometry at all: no rows claimed, no DECSTBM churn, nothing to re-flow.
 *
 * Three states, matching {@link MascotState}:
 *   - `idle`    — eyes forward, ears down. One frame (no animation, no timer).
 *   - `working` — rest-dominant cackle cycle: an ear flick, a blink, a glint,
 *     and a resting face between each. Punctuation on a still sprite, not a
 *     second spinner.
 *   - `alert`   — two-frame red-eyed flap; used when a tool returns an error.
 *
 * Deliberately no emoji and no Geometric-Shapes glyphs: half-blocks (▀▄) are
 * the only characters with dependable cross-terminal cell metrics, so the
 * sprite is exactly MINI_MASCOT_WIDTH columns wide in any font — which is what
 * lets the rail budget its right edge arithmetically.
 */

import { renderHalfBlockGrid, mascotSuppressed, type MascotState } from './mascot.js';

/** Character-cell footprint of the mini sprite. */
export const MINI_MASCOT_WIDTH = 7;
/**
 * Character rows. One, deliberately — see the module docstring: a sprite that
 * fits an existing row costs no rows, and costing no rows is what keeps it
 * unobtrusive.
 */
export const MINI_MASCOT_HEIGHT = 1;

/*
 * Invariant: every grid below is MINI_MASCOT_WIDTH columns × MINI_MASCOT_HEIGHT*2
 * pixel rows, and every row is a left-right palindrome. The width/height rule is
 * what lets the rail reserve a fixed right-edge budget for the sprite; the
 * palindrome rule is what keeps a 7-column face from reading as lopsided (at
 * this scale a single off-centre pixel is a visible defect, unlike the
 * 27-column banner sprite where the cap can lean). `mascot-mini.test.ts` pins
 * both mechanically for all frames of all states, so a new frame that breaks
 * either rule fails the suite rather than corrupting the row's width budget.
 *
 * The two pixel rows pair into the single character row (see
 * renderHalfBlockGrid): the TOP pixel row paints the upper half of each cell,
 * the BOTTOM pixel row the lower half. So the sprite is read as
 *
 *   upper half:  cap (and the ears, when they flick up into it)
 *   lower half:  ears, jaw outline, eyes, nose
 *
 * Palette tokens are PIXEL_PALETTE's (mascot.ts): B brown cap, Y gold eyes,
 * M olive skin, D dark-olive ears, K near-black outline, L light-olive glint,
 * R alarm red, '.' transparent.
 */

// Top pixel row — the brown cap, narrower than the face so the silhouette
// still peaks. `UP` lifts the ears into this row (see the transparency rule).
const CAP_EARS_DOWN = '..BBB..';
const CAP_EARS_UP = 'D.BBB.D';

// Bottom pixel row — ears, jaw outline, eyes, nose. The outer cell is empty in
// the `_UP` variants because the ear has moved into the row above it.
const FACE_OPEN = 'DKYMYKD'; // eyes forward
const FACE_SHUT = 'DKMMMKD'; // blink — eyes close into the face
const FACE_GLINT = 'DKLMLKD'; // light-olive glint
const FACE_UP_OPEN = '.KYMYK.'; // ears raised, eyes forward
const FACE_UP_RED = '.KRMRK.'; // ears raised, alarm red
const FACE_RED = 'DKRMRKD'; // ears down, alarm red

type Grid = readonly [string, string];

const REST: Grid = [CAP_EARS_DOWN, FACE_OPEN];
const PERK: Grid = [CAP_EARS_UP, FACE_UP_OPEN];
const BLINK: Grid = [CAP_EARS_DOWN, FACE_SHUT];
const GLINT: Grid = [CAP_EARS_DOWN, FACE_GLINT];
const FLARE: Grid = [CAP_EARS_UP, FACE_UP_RED];
const FLINCH: Grid = [CAP_EARS_DOWN, FACE_RED];

/*
 * Invariant: every animated state must contain at least one frame that differs
 * from the others in TRANSPARENCY, not only in palette tokens.
 *
 * A half-block cell renders ▀ whenever its TOP pixel is opaque, whatever the
 * colours and whatever the bottom pixel is; only a transparent top pixel
 * changes the glyph (to ▄, or to a space when the bottom is transparent too).
 * So frames differing only in hue are glyph-identical, and at `chalk.level === 0`
 * (NO_COLOR, CI, piped output) the animation would freeze into a still
 * silhouette. Hence the ear flick: PERK/FLARE move the ear pixel from the
 * bottom row to the top row, flipping the outer cells from ▄ to ▀. That is the
 * mono beat for both animated states — the blink and the glint are colour-only
 * and carry the expression in a truecolor terminal.
 * `mascot-mini.test.ts` pins it by rendering every frame at level 0 and
 * asserting the set is not a single frame.
 */
const FRAMES: Record<MascotState, readonly Grid[]> = {
  idle: [REST],
  /*
   * Rhythm, not churn: the resting face is the majority of the cycle and every
   * expressive frame is followed by it, so the sprite reads as a creature that
   * occasionally twitches rather than as a second spinner next to the real one.
   * At LiveMascot's frame interval this is a ~2.4s loop carrying three beats.
   */
  working: [REST, REST, PERK, REST, BLINK, REST, GLINT, REST],
  alert: [FLARE, FLINCH],
};

/** How many animation frames a state cycles through (≥1). */
export function miniMascotFrameCount(state: MascotState): number {
  return FRAMES[state].length;
}

/**
 * Render one frame of the mini mascot as a single ANSI-styled character row.
 *
 * Contract: returns exactly MINI_MASCOT_HEIGHT lines, or `[]` when the sprite
 * is suppressed (`AFK_BANNER_PLAIN=1`) — callers must treat `[]` as "render no
 * decoration" rather than padding it out. `frame` is taken modulo the state's
 * frame count, so a caller may pass a monotonically increasing tick without
 * bounds checks. Colour degradation is chalk's: at `chalk.level === 0`
 * (NO_COLOR, CI, non-TTY) the same half-blocks render as an uncoloured
 * silhouette.
 */
export function renderMiniMascotLines(
  state: MascotState = 'idle',
  frame = 0,
): string[] {
  if (mascotSuppressed()) return [];
  const frames = FRAMES[state];
  const idx = ((frame % frames.length) + frames.length) % frames.length;
  return renderHalfBlockGrid(frames[idx] ?? frames[0]!);
}

/** Exposed for test introspection (grid shape / palette / symmetry pins). */
export const __MINI_MASCOT_FRAMES_FOR_TESTS = FRAMES;
