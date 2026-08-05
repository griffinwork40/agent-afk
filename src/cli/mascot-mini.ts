/**
 * The live mini-mascot — a 3-row reacting goblin for the reserved footer band.
 *
 * The banner goblin in `mascot.ts` is a 27×13 portrait: far too tall to live
 * on-screen during a turn. This module carries its compact cousin — the same
 * palette, the same half-block renderer (`renderHalfBlockGrid`), the same
 * fallback ladder — sized to fit the `extraRows` footer band that
 * `MascotBar` (commands/interactive/mascot-bar.ts) reserves while the agent
 * runs tools.
 *
 * Three states, matching {@link MascotState}:
 *   - `idle`    — eyes forward, mouth closed. One frame (no animation).
 *   - `working` — four-frame cackle cycle: eyes blink and glint, grin opens.
 *   - `alert`   — two-frame red-eyed pulse; used when a tool returns an error.
 *
 * Deliberately no emoji and no Geometric-Shapes glyphs: half-blocks (▀▄) are
 * the only characters with dependable cross-terminal cell metrics, so every
 * row is exactly MINI_MASCOT_WIDTH columns wide in any font.
 */

import { renderHalfBlockGrid, mascotSuppressed, type MascotState } from './mascot.js';

/** Character-cell footprint of the mini sprite. */
export const MINI_MASCOT_WIDTH = 13;
/** Character rows. Issue #336 caps the live sprite at 3. */
export const MINI_MASCOT_HEIGHT = 3;

/**
 * Invariant: every grid below is MINI_MASCOT_WIDTH columns × MINI_MASCOT_HEIGHT*2
 * pixel rows, and every row is a left-right palindrome. The width/height rule is
 * what lets `MascotBar` reserve a fixed 3-row band and clear exactly what it
 * painted; the palindrome rule is what keeps a 13-column face from reading as
 * lopsided (at this scale a single off-centre pixel is a visible defect, unlike
 * the 27-column banner sprite where the cap can lean). `mascot-mini.test.ts`
 * pins both mechanically for all frames of all states, so a new frame that
 * breaks either rule fails the suite rather than corrupting the band geometry.
 *
 * Pixel rows pair into character rows top/bottom (see renderHalfBlockGrid):
 *   char row 0 = cap tip over cap body     (pixel rows 0,1) -> pointed cone
 *   char row 1 = gold hatband over brow    (pixel rows 2,3) -> band + ear tips
 *   char row 2 = eye band over grin        (pixel rows 4,5) -> face
 *
 * Palette tokens are PIXEL_PALETTE's (mascot.ts): B brown cap, Y gold, M olive
 * skin, D dark-olive ears, K near-black outline, L light-olive glint, R alarm
 * red, '.' transparent. Only the eye band and grin change between frames — the
 * cap and brow are shared, so animation reads as expression, not as jitter.
 */
const CAP_ROWS: readonly string[] = [
  '.....BBB.....', // cap tip
  '...BBBBBBB...', // cap body
  '..KYYYYYYYK..', // gold hatband
  'DDKMMMMMMMKDD', // brow, ears at their widest
];

/** Compose a full grid from the shared cap/brow rows + a face pair. */
function grid(eyeRow: string, grinRow: string): readonly string[] {
  return [...CAP_ROWS, eyeRow, grinRow];
}

/*
 * Invariant: every animated state must contain at least one frame that differs
 * from the others in TRANSPARENCY, not only in palette tokens.
 *
 * A half-block cell renders ▀ whenever both of its pixels are opaque, whatever
 * their colours, and a transparent BOTTOM pixel does not change the glyph either
 * — only a transparent TOP pixel (▄) or a fully transparent cell (space) does.
 * So frames differing only in hue are glyph-identical, and at `chalk.level === 0`
 * (NO_COLOR, CI, piped output) the animation would freeze into a still
 * silhouette. The levers that survive colour loss are therefore the eye row's
 * transparency and the sprite's outline width:
 *   - the blink frame drops the eye pixels (opaque/opaque → transparent/opaque),
 *     flipping those cells from ▀ to ▄ — this is `working`'s mono beat;
 *   - `alert` flares the ears into the eye row, widening the last character row
 *     from 11 columns to 13, and its wince frame blinks as well.
 * Colour does the expressive work in a truecolor terminal; this rule is what
 * keeps motion *visible* when colour is gone. `mascot-mini.test.ts` pins it by
 * rendering every frame at level 0 and asserting the set is not a single frame.
 */

// Eye bands (pixel row 4) — eyes at cols 4 and 8, ears tapering at the edges.
const EYES_OPEN = '.DKMYMMMYMKD.'; // gold eyes forward
const EYES_SHUT = '.DKM.MMM.MKD.'; // blink — sockets drop out (glyph change)
const EYES_GLINT = '.DKMLMMMLMKD.'; // light-olive glint
const EYES_RED = 'DDKMRMMMRMKDD'; // alarm red, ears flared wide
const EYES_WINCE = 'DDKM.MMM.MKDD'; // alarm wince, ears still flared

// Grins (pixel row 5) — jaw narrower than the brow above it.
const GRIN_CLOSED = '..KMMKKKMMK..'; // narrow closed grin
const GRIN_OPEN = '..KMKKKKKMK..'; // open cackle
const GRIN_GRIMACE = '..KKKKKKKKK..'; // full-width grimace (alert)

/**
 * Frames per state. `idle` is a single frame so a resting mascot costs no
 * timer ticks; `working`/`alert` cycle at MascotBar's frame interval.
 */
const FRAMES: Record<MascotState, readonly (readonly string[])[]> = {
  idle: [grid(EYES_OPEN, GRIN_CLOSED)],
  working: [
    grid(EYES_OPEN, GRIN_CLOSED),
    grid(EYES_SHUT, GRIN_OPEN),
    grid(EYES_GLINT, GRIN_CLOSED),
    grid(EYES_OPEN, GRIN_OPEN),
  ],
  alert: [grid(EYES_RED, GRIN_GRIMACE), grid(EYES_WINCE, GRIN_OPEN)],
};

/** How many animation frames a state cycles through (≥1). */
export function miniMascotFrameCount(state: MascotState): number {
  return FRAMES[state].length;
}

/**
 * Render one frame of the mini mascot as ANSI-styled character rows.
 *
 * Contract: returns exactly MINI_MASCOT_HEIGHT lines, or `[]` when the sprite
 * is suppressed (`AFK_BANNER_PLAIN=1`) — callers must treat `[]` as "reserve no
 * rows" rather than padding it out. `frame` is taken modulo the state's frame
 * count, so a caller may pass a monotonically increasing tick without bounds
 * checks. Colour degradation is chalk's: at `chalk.level === 0` (NO_COLOR, CI,
 * non-TTY) the same half-blocks render as an uncoloured silhouette.
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
