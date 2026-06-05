/**
 * AFK mascot — the olive-green goblin that anchors the welcome banner
 * and (later) ambient status surfaces.
 *
 * The half-block (`▀`) pixel-art renderer pairs adjacent pixel rows into
 * terminal character rows. The pixel grid is human-readable: characters
 * in GOBLIN_GRID map to palette entries. Edit the grid to redesign the
 * mascot; no string-splicing or chalk concatenation needed.
 *
 * Fallback ladder (highest → lowest fidelity):
 *   1. Truecolor: full 24-bit pixel sprite via half-block characters
 *   2. `chalk.level === 0` or `NO_COLOR=1`: silhouette only
 *   3. `AFK_BANNER_PLAIN=1`: empty sprite (legacy boxed wordmark)
 */

import chalk from 'chalk';
import { env } from '../config/env.js';

/** Future-state vocabulary. Only `idle` renders currently. */
export type MascotState = 'idle' | 'working' | 'alert';

/** Single-character codes → RGB tuples. `null` = transparent. */
const PIXEL_PALETTE: Record<string, [number, number, number] | null> = {
  '.': null,
  D: [74, 92, 36],
  M: [139, 166, 63],
  L: [178, 197, 88],
  Y: [245, 213, 71],
  K: [13, 18, 9],
  W: [238, 238, 222],
  // Dark olive — used for the subtle smirk below the nose.
  // #2A2A1A ≈ [42, 42, 26]
  X: [42, 42, 26],
};

/**
 * 19×16 pixel grid. Rows are symmetric except for the deliberately
 * offset tooth pixels. Row count must be even.
 *
 * v12 "smug debugging gremlin" — sharpens three v11 cues that were
 * legible-but-quiet into ones that read on first glance. Each change
 * is bounded by the test invariants (bracket-shaped D/K ears, mostly
 * symmetric rows with intentional tooth asymmetry, `.` corner dots on
 * rows 0/6/14/15, palette must still surface Y/M/L/K/W, no R).
 *
 * Concrete changes vs. v11:
 *
 *   - Angle-bracket ears that actually trace `<` / `>`. v11 left the
 *     ear as a 2-px D stub at row 4 cols 0,1 (with col 2 forced `.`
 *     by the test). v12 adds the inner arm tips of the bracket at
 *     row 3 col 2 and row 5 col 2 (and their mirrors at col 14), so
 *     the silhouette becomes:
 *
 *         . . D       ← upper arm tip   (row 3)
 *         D D .       ← bracket point   (row 4, pinned by tests)
 *         . . D       ← lower arm tip   (row 5)
 *
 *     The arm-tip D's at row 5 sit between hood K's (col 1 K, col 3
 *     K), so the olive pixel peeks out one cell as the bracket's
 *     lower jaw — same trick on row 3 against the open `.` margin.
 *     The eye fills the diagonals; the shape reads as `<` instead
 *     of a featureless wedge.
 *
 *   - `{ }` brace forehead glyph (staircase, not paired dots). v11
 *     used a single pair of W pixels at row 2 cols 6, 10 — a glint
 *     but no shape. v12 walks the W's into a 3-row staircase that
 *     traces the curl of `{` and `}`:
 *
 *         W . K . L . K . W      ← top hook   (row 1, cols 5,11)
 *         K W M L M W K          ← middle stem (row 2, cols 6,10)
 *         W L M M M L W          ← bottom hook (row 3, cols 5,11)
 *
 *     The diagonal W run on each side is the outer-inner-outer curve
 *     of a brace; the L peek (row 1 col 8, row 3 cols 6,10) stays
 *     centered between them as the "value" inside the braces.
 *
 *   - Smug debugging squint. v11's eyes were a 2-px-tall Y vertical
 *     bar per side (cursor caret). v12 replaces the top half with K
 *     (row 7 cols 6, 10 → K), keeping Y only at row 8 — a lidded
 *     eye-slit peeking out from under a dark mask. Reads as a
 *     half-mast smug squint rather than wide-open caret eyes.
 *
 *   - Smirk corners that curl up. v11's mouth was a 3-px K bar with
 *     one W tooth at row 10. v12 keeps that mouth identical but adds
 *     K dimples at row 9 cols 6 and 10 — diagonally above the mouth
 *     ends — so the corners of the smirk lift into the cheek. The
 *     palindrome forces them to lift on both sides, which reads as a
 *     closed-mouth smug grin (the asymmetric one-sided smirk is
 *     unreachable under the symmetry invariant).
 *
 *   - Dark-olive lower smirk (v12.3). v12.2's two X pixels sat close
 *     enough to the nose ridge that they could read as nostrils. v12.3
 *     quiets the nose to one center D pixel, keeps row 9 as a clean M
 *     gap, and bends the mouth into a tiny arc: raised X corners on
 *     row 10 connected by a lower X run on row 11. That keeps the
 *     expression closed-mouth without reading as either a flat bar or
 *     three separate dots.
 *
 *   - Offset fang (v12.4). One off-white W fang drops from the lower
 *     mouth edge into row 12, offset left of center, while a single
 *     square W tooth stays on the opposite side of the mouth row.
 *
 *   - Shadow mouth + wider brackets (v12.5). The extra square tooth is
 *     removed, the mouth becomes a small X shadow cut with one narrow
 *     two-pixel W fang offset left, and the sprite grows to 19 columns
 *     so each bracket ear can sharpen one pixel farther outward. The
 *     upper/lower ear arms stay inset while the center row points out,
 *     keeping the silhouette bracket-like instead of blocky.
 */
const GOBLIN_GRID: readonly string[] = [
  // hood crest — dark cap on top of the head
  '.......KKKKK.......',
  // forehead row 1: `{ }` top hook (W at cols 5, 11) + central L peek
  '......WKKLKKW......',
  // forehead row 2: `{ }` middle stem (W at cols 6, 10) flanking L
  '.....KKWMLMWKK.....',
  // forehead row 3 + upper bracket arms: inset arms with K inner outline
  '..DDKKWLMMMLWKKDD..',
  // angle-bracket ears (`<` / `>`) — outward D points, open behind the tip
  'DDD..KMMMMMMMK..DDD',
  // lower bracket arms — inset to complete the angled bracket silhouette
  '..DDKMMMMMMMMMKDD..',
  // brow line + hood sides
  '...KKMMKKKKKMMKK...',
  // smug squint — lidded eye top: K mask covers what was v11's upper Y bar
  '...KMMKKKKKKKMMK...',
  // eye-slit (Y peeks under the lid) + quiet single-pixel nose
  '...KMMMYMDMYMMMK...',
  // gap row between nose and mouth (keeps the K nose from fusing with the smirk)
  '...KMMMMMMMMMMMK...',
  // mouth shadow — small dark cut into the face
  '...KKMMXXXXXMMKK...',
  // lower-edge fang — first off-white pixel, offset left; no extra teeth
  '....KKMMWXXMMKK....',
  // fang tip — second vertical fang pixel, still one tooth
  '.....KKMWMMMKK.....',
  '.....KKMMMMMKK.....',
  '......KKMMMKK......',
  '.......KKKKK.......',
];

export const MASCOT_WIDTH = 19;
export const MASCOT_HEIGHT = 8;

/** Render two stacked pixel rows as one terminal character row via half-block technique. */
function renderPixelRow(top: string, bot: string): string {
  if (top.length !== bot.length) {
    throw new Error(
      `pixel row width mismatch: top=${top.length}, bot=${bot.length}`,
    );
  }
  let line = '';
  for (let c = 0; c < top.length; c++) {
    const topPx = PIXEL_PALETTE[top[c] ?? '.'] ?? null;
    const botPx = PIXEL_PALETTE[bot[c] ?? '.'] ?? null;
    if (!topPx && !botPx) {
      line += ' ';
    } else if (topPx && !botPx) {
      line += chalk.rgb(topPx[0], topPx[1], topPx[2])('▀');
    } else if (!topPx && botPx) {
      line += chalk.rgb(botPx[0], botPx[1], botPx[2])('▄');
    } else if (topPx && botPx) {
      line += chalk
        .bgRgb(botPx[0], botPx[1], botPx[2])
        .rgb(topPx[0], topPx[1], topPx[2])('▀');
    }
  }
  return line;
}

/** Pair adjacent pixel rows into terminal character rows. */
function buildSpriteIdle(): string[] {
  if (GOBLIN_GRID.length !== MASCOT_HEIGHT * 2) {
    throw new Error(
      `GOBLIN_GRID has ${GOBLIN_GRID.length} pixel rows but MASCOT_HEIGHT*2 = ${
        MASCOT_HEIGHT * 2
      }`,
    );
  }
  const lines: string[] = [];
  for (let r = 0; r < MASCOT_HEIGHT; r++) {
    const top = GOBLIN_GRID[r * 2] ?? '';
    const bot = GOBLIN_GRID[r * 2 + 1] ?? '';
    lines.push(renderPixelRow(top, bot));
  }
  return lines;
}

/** Render the mascot sprite as an array of ANSI-styled lines. */
export function renderMascotLines(state: MascotState = 'idle'): string[] {
  if (env.AFK_BANNER_PLAIN === '1') {
    return [];
  }
  void state; // future variants branch here
  return buildSpriteIdle();
}

/** `true` when `AFK_BANNER_PLAIN=1` is set. */
export function mascotSuppressed(): boolean {
  return env.AFK_BANNER_PLAIN === '1';
}

/** Exposed for test introspection. */
export const __GOBLIN_GRID_FOR_TESTS = GOBLIN_GRID;
