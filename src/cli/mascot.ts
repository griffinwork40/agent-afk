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
  // Brown — the goblin's leather cap (cone + body); the gold band sits below it.
  // Deep leather brown — kept clearly above the terminal black (#0D1209) so it
  // still reads as "brown" (not a black void) while contrasting the gold band
  // below. Darkened a second time on request (was #5A3A20).
  // #3C2614 ≈ [60, 38, 20]
  B: [60, 38, 20],
};

/**
 * Invariant: MASCOT_WIDTH×(MASCOT_HEIGHT*2) pixel grid (row count must be
 * even — paired into MASCOT_HEIGHT half-block rows); every row's length
 * must equal MASCOT_WIDTH. The face (rows 7+) is left-right symmetric; the
 * brown cap cone (rows 0–6) deliberately leans right, and the lone fang is
 * an asymmetric glyph overlay (see GLYPH_OVERLAY), not a grid pixel.
 * `mascot.test.ts` pins the load-bearing shape.
 *
 * v14 "sadistic code goblin": a brown leather cap (rows 0–6) over a gold
 * hatband (row 7); plain olive forehead; big swept dark-olive ears
 * (rows 10–17) flanking the temples; a heavy dark brow over yellow eyes
 * with forward pupils and dark under-eye bags (rows 12–16); a shaded
 * protruding nose (rows 15–18); and a symmetric closed grin (rows 20–21)
 * with a single short fang hung at the viewer's-left canine position via
 * the glyph overlay. Supersedes the hooded "wide-eyed gremlin" (v13).
 */
const GOBLIN_GRID: readonly string[] = [
  // pointed goblin cap (brown leather) — clean cone, tip leans right
  '..............BBB..........',
  '............BBBBB..........',
  '..........BBBBBBB..........',
  '.........BBBBBBBBB.........',
  // cap body widening to the head
  '.......BBBBBBBBBBBB........',
  '......BBBBBBBBBBBBBB.......',
  '.....BBBBBBBBBBBBBBBBB.....',
  // gold hatband — the "this is a hat" signal
  '.....KYYYYYYYYYYYYYYYK.....',
  // forehead — plain olive under the cap
  '.....KMMMMMMMMMMMMMMMK.....',
  // upper face
  '.....KMMMMMMMMMMMMMMMK.....',
  // big ears begin (D) flanking the temples
  '....DKMMMMMMMMMMMMMMMKD....',
  // ears growing outward
  '...DDKMMMMMMMMMMMMMMMKDD...',
  // brow ridge — heavy dark, over the eyes; ears wider
  '.DDDDKMKKKKKMMMKKKKKMKDDDD.',
  // heavy hooded lids + ears at their widest points
  'DDDDDKMMKKKMMMMMKKKMMKDDDDD',
  // eyes — yellow slit peering out; ears taper
  '.DDDDKMMYYYMMMMMYYYMMKDDDD.',
  // pupils gaze forward from under the lids + lit nose bridge
  '..DDDKMMYKYMMLMMYKYMMKDDD..',
  // under-eye bags (dark-olive) + nose bridge; ears end
  '...DDKMMDDDMMLMMDDDMMKDD...',
  // nose widens — lit ridge, shadowed sides; gaunt cheek hollows
  '....DKMDMMMMDLDMMMMDMKD....',
  // bulbous nose tip (dark underside) + cheek hollows
  '.....KMDMMMMDDDMMMMDMK.....',
  // upper lip / cheeks
  '.....KMMMMMMMMMMMMMMMK.....',
  // grin — both corners pulled UP (symmetric closed-mouth smile)
  '.....KMMKKMMMMMMMKKMMK.....',
  // grin — low curve across the middle (mouth stays closed)
  '.....KMMMKKKKKKKKKMMMK.....',
  // jaw — fang (▼ glyph overlay) pokes down out of the grin here
  '.....KMMMMMMMMMMMMMMMK.....',
  // jaw narrowing
  '......KMMMMMMMMMMMMMK......',
  // chin
  '........KMMMMMMMMMK........',
  // chin base
  '..........KMMMMMK..........',
];

export const MASCOT_WIDTH = 27;
export const MASCOT_HEIGHT = 13;

/**
 * Glyph overlays — whole-character-cell overrides applied on top of the
 * half-block pass, for accent shapes the half-block pixel grid cannot express
 * (a pointed fang). Keyed `"charRow,col"` in CHARACTER coordinates (one cell ==
 * two stacked grid pixels). `fg`/`bg` are PIXEL_PALETTE tokens; `'.'` = none.
 * Invariant: triangle/diagonal glyphs live in the Geometric-Shapes Unicode
 * block and render less consistently across terminal fonts (size, offset, and
 * ambiguous display width) than the Block-Elements half-blocks — confine
 * overlays to small accents (teeth), never load-bearing silhouette.
 */
const GLYPH_OVERLAY: Readonly<
  Record<string, { char: string; fg: string; bg: string }>
> = {
  // single short fang — small off-white triangle hanging from the LEFT side of
  // the grin (viewer's left, canine position col 11); flat top flush against the
  // dark mouth band above it (rooted at the gumline), olive bg so the face skin
  // shows behind/around the tooth (no dark socket).
  '11,11': { char: '▾', fg: 'W', bg: 'M' },
};

/** Colorize one overlay glyph with optional fg/bg palette tokens. */
function styleGlyph(glyph: { char: string; fg: string; bg: string }): string {
  const fg = PIXEL_PALETTE[glyph.fg] ?? null;
  const bg = PIXEL_PALETTE[glyph.bg] ?? null;
  if (fg && bg)
    return chalk.bgRgb(bg[0], bg[1], bg[2]).rgb(fg[0], fg[1], fg[2])(glyph.char);
  if (fg) return chalk.rgb(fg[0], fg[1], fg[2])(glyph.char);
  if (bg) return chalk.bgRgb(bg[0], bg[1], bg[2])(glyph.char);
  return glyph.char;
}

/** Render two stacked pixel rows as one terminal character row via half-block technique. */
function renderPixelRow(top: string, bot: string, charRow: number): string {
  if (top.length !== bot.length) {
    throw new Error(
      `pixel row width mismatch: top=${top.length}, bot=${bot.length}`,
    );
  }
  let line = '';
  for (let c = 0; c < top.length; c++) {
    // Whole-cell glyph overlay wins over the half-block pair beneath it.
    const overlay = GLYPH_OVERLAY[`${charRow},${c}`];
    if (overlay) {
      line += styleGlyph(overlay);
      continue;
    }
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
    lines.push(renderPixelRow(top, bot, r));
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

/** Exposed for test/preview introspection. */
export const __GLYPH_OVERLAY_FOR_TESTS = GLYPH_OVERLAY;
