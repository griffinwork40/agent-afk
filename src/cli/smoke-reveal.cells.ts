/**
 * Per-cell renderers for the text reveal: the calm ink fade (default for
 * prose) and the smoke condense (accent for headings), plus the drifting
 * wisp that runs ahead of a smoke front.
 *
 * Invariant (no overshoot): a revealing character is NEVER drawn brighter
 * than its settled self. The first smoke reveal ramped every letter up to a
 * near-white tone and then snapped it down to its dimmer real color, which
 * read as a flashbulb sweep. Here a letter either blends toward its own exact
 * RGB (when the formatter gave it one; basic white blends toward the theme's
 * near-foreground, which sits at or below it) or, when its color belongs to the
 * terminal's palette and cannot be known, climbs a low smoke tone and then
 * shows its real color with the faint attribute before settling. Both paths
 * only ever get brighter.
 *
 * Contract: every renderer returns a string that occupies exactly the same
 * number of columns as the settled character, ends by restoring `state`
 * (so the following text keeps its styling), and never emits anything but
 * SGR escapes around the cell.
 *
 * @module cli/smoke-reveal.cells
 */

import stringWidth from 'string-width';
import { SMOKE_GLYPH_LEVELS, charLifetime, seedUnit, smokeGlyph, smokeToneOffset, smoothstep } from './smoke-reveal.frame.js';
import { mixOklab } from './smoke-reveal.oklab.js';
import { toneRgb, type Rgb } from './smoke-reveal.tones.js';
import { EMPTY_SGR, fgParams, isBasicWhite, knownFgRgb, paletteIndex, serializeSgr, type SgrState } from './smoke-reveal.sgr.js';
import { getTerminalColors } from './terminal-colors.js';

export type RevealStyle = 'ink' | 'smoke';

/** Ink fade duration. Long enough to read as a soft trailing edge, short enough to never feel slow. */
export const INK_MS = 340;
/**
 * Width of the ink trailing edge in characters. A letter is settled once it
 * is `INK_MS` old OR this many characters behind the front, whichever comes
 * first. Time alone would make the edge as wide as `rate * INK_MS`, so a
 * fast catch-up would paint a whole paragraph faint at once and then sweep
 * it bright: a block again. Capping by distance keeps a narrow, constant
 * band while text flows; time still settles the tail when the flow stops.
 */
export const INK_TRAIL_CHARS = 30;
/** Ramp position a fresh ink letter starts from: a visible dim tone above the background. */
export const INK_FLOOR = 0.22;
/**
 * Historical alias kept for compatibility; matches `INK_FLOOR` now that the
 * floor was raised to a visible dim tone.
 */
export const INK_DIM = 0.22;
/** Share of the ink fade spent as a floor speck before the faint stage (unknown colors only). */
export const INK_SPECK_PHASE = 0.3;

/**
 * Smoke lifetime (base; per-letter jitter only shortens it). Smoke is the
 * default prose style, so this is the "condense speed" of body text: about
 * 1.5x main's original 320 ms, which the operator liked but found a little
 * fast. Slower is only safe because commit-defer waits for a block's last
 * letters to condense before committing it; without that wait every
 * paragraph ends with its still-smoking tail snapping to plain text.
 */
export const SMOKE_MS = 500;
/** Share of the smoke lifetime spent as a particle before the letter appears (main's original look). */
export const SMOKE_GLYPH_PHASE = 0.36;
/** Ramp position of the densest particle, and where the letter phase starts. */
const SMOKE_PEAK = 0.36;

/** Cells of wisp drawn ahead of a smoke front. */
export const WISP_CELLS = 3;
/** How long the wisp lingers after the front stops advancing. */
export const WISP_MS = 400;
/** Wisp drift cadence: the pattern shifts one cell right per step. */
export const WISP_STEP_MS = 100;
const WISP_LANE = 97;
/**
 * Period of the brightness wave that rolls through the wisp. Its tone is
 * recomputed every frame from this, so the wisp moves continuously even
 * though its dot texture only shifts every `WISP_STEP_MS`.
 */
const WISP_WAVE_MS = 620;
/** Depth of that wave (share of the wisp's tone that swells and ebbs). */
const WISP_WAVE_DEPTH = 0.35;

/** Lifetime of a character revealed with `style`. */
export function lifetimeOf(style: RevealStyle, seed: number): number {
  return style === 'ink' ? INK_MS : charLifetime(seed, SMOKE_MS);
}

/** Longest lifetime any character can have (for pruning finished bursts). */
export const MAX_LIFETIME_MS = Math.max(INK_MS, SMOKE_MS);

function tone(t: number): string {
  return fgParams(toneRgb(t));
}

/**
 * The color `state` will settle on, when it can be known: an exact truecolor
 * or 256-color fg, a basic color looked up in the terminal's discovered
 * palette, or the discovered default fg for plain text. Basic white without
 * a discovered palette falls back to the ramp's bright end, which sits at or
 * below it. Null means unknowable (e.g. inverse, or nothing discovered).
 */
export function settledRgb(state: SgrState): Rgb | null {
  if (state.inverse) return null;
  const exact = knownFgRgb(state);
  if (exact) return exact;
  const found = getTerminalColors();
  const idx = paletteIndex(state);
  if (idx !== null) return found?.palette.get(idx) ?? (isBasicWhite(state) ? toneRgb(1) : null);
  if (state.fg === null) return found?.fg ?? null;
  return null;
}

/**
 * The letter itself at blend `p` in [0, 1] from ramp position `from` toward
 * its settled look. A known target blends continuously through OKLab on a
 * smoothstep curve (first frame barely moves; lands with no corner). An
 * unknowable target cannot be blended, so it holds a faint speck (only for
 * the ink floor, which sits below any readable text) and then shows its real
 * color with the faint attribute: both steps only ever get brighter. The
 * previous ramp climb could pass the terminal's own faint level on a dim
 * theme and then visibly darken at the hand-off.
 */
function letter(ch: string, state: SgrState, from: number, p: number): string {
  const target = settledRgb(state);
  if (target) {
    const rgb = mixOklab(toneRgb(from), target, smoothstep(p));
    return serializeSgr(state, fgParams(rgb)) + ch;
  }
  if (p < INK_SPECK_PHASE && from <= INK_FLOOR) {
    return serializeSgr({ ...state, faint: false }, tone(from)) + ch;
  }
  return serializeSgr({ ...state, faint: true }) + ch;
}

/**
 * Ink cell at `age` ms and `behind` characters from the front (0 = newest),
 * or null once settled (caller emits the original text).
 */
export function inkCell(ch: string, age: number, state: SgrState, behind = 0): string | null {
  const p = Math.max(age / INK_MS, behind / INK_TRAIL_CHARS);
  if (p >= 1) return null;
  return letter(ch, state, INK_FLOOR, p) + serializeSgr(state);
}

/** Smoke cell at `age` ms, or null once settled. */
export function smokeCell(ch: string, age: number, seed: number, state: SgrState): string | null {
  const life = charLifetime(seed, SMOKE_MS);
  if (age >= life) return null;
  const f = age / life;
  if (f < SMOKE_GLYPH_PHASE && stringWidth(ch) === 1) {
    const p = f / SMOKE_GLYPH_PHASE;
    const t = 0.1 + (SMOKE_PEAK - 0.1) * p + smokeToneOffset(seed);
    return serializeSgr(EMPTY_SGR, tone(t)) + smokeGlyph(p, seed) + serializeSgr(state);
  }
  const p = f < SMOKE_GLYPH_PHASE ? 0 : (f - SMOKE_GLYPH_PHASE) / (1 - SMOKE_GLYPH_PHASE);
  return letter(ch, state, SMOKE_PEAK, p) + serializeSgr(state);
}

/**
 * One wisp cell `k` columns ahead of a smoke front (k >= 1), or null for an
 * empty cell, or '' once the wisp has faded. `frontAge` is the front
 * character's age; `now` drives the drift. The pattern at cell k and step n
 * equals the pattern at cell k-1 and step n-1, so the texture visibly
 * travels rightward while it thins out. Callers restore their own style.
 */
export function wispCell(k: number, frontAge: number, now: number, seed: number): string | null {
  if (frontAge >= WISP_MS || k < 1 || k > WISP_CELLS) return '';
  const strength = 1 - Math.max(0, frontAge) / WISP_MS;
  const u = seedUnit(seed + Math.floor(now / WISP_STEP_MS) - k, WISP_LANE);
  if (u < 0.22) return null;
  const level = SMOKE_GLYPH_LEVELS[k === 1 ? 1 : 0] ?? [];
  const glyph = level[Math.floor(u * 997) % Math.max(1, level.length)] ?? '⠁';
  const wave = 1 - WISP_WAVE_DEPTH * (0.5 + 0.5 * Math.sin(2 * Math.PI * (now / WISP_WAVE_MS - k / WISP_CELLS)));
  const t = (0.2 - 0.045 * k) * strength * wave;
  return serializeSgr(EMPTY_SGR, fgParams(toneRgb(Math.max(0.03, t)))) + glyph;
}

/** The whole `WISP_CELLS`-wide wisp (for a front with no reserved cells after it), or '' once faded. */
export function wispCells(frontAge: number, now: number, seed: number): string {
  if (frontAge >= WISP_MS) return '';
  let out = '';
  for (let k = 1; k <= WISP_CELLS; k++) out += wispCell(k, frontAge, now, seed) ?? ' ';
  return out;
}
