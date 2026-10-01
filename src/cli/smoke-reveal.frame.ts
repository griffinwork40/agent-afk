/**
 * Smoke-text per-character variation: the pieces that make a reveal read as
 * drifting smoke instead of a uniform progress gradient.
 *
 * Without variation, every character of the same age renders the same glyph
 * at the same tone, so the leading edge of a stream is one repeating comb
 * (`⠁⠂⠢⠶⠁⠂⠢⠶`). This module gives each character a stable seed that drives
 * three small, independent differences:
 *
 *  - its own condense speed (`charLifetime`): a fraction of letters settle a
 *    little early, so the fade front is ragged rather than a straight band;
 *  - its own particle shape (`smokeGlyph`): its own order for raising braille
 *    dots, so neighbours condense differently while each one only gains dots;
 *  - a slight tone offset while it is still smoke (`smokeToneOffset`).
 *
 * Invariant (stable per character): every value here is a pure function of
 * the character's seed, never of the clock or a random source. A character
 * keeps one shape per density level for as long as it is on screen, so the
 * variation never flickers between repaints. The caller derives the seed from
 * the character's position in the recorded stream (see `SmokeReveal`), which
 * survives block commits and re-wrapping.
 *
 * Invariant (never later than the base lifetime): `charLifetime` only ever
 * SHORTENS a character's fade. `SmokeReveal` prunes bursts and stops its
 * settle driver on the un-jittered `LIFETIME_MS`, so a character that
 * outlived it would snap solid mid-fade.
 *
 * @module cli/smoke-reveal.frame
 */

/** Dots a smoke particle has at its faintest and densest density levels. */
const MIN_DOTS = 1;
const MAX_DOTS = 5;

/** Every braille pattern (U+2800 block) with exactly `n` of its 8 dots raised. */
function brailleWithDots(n: number): string[] {
  const out: string[] = [];
  for (let bits = 1; bits < 256; bits++) {
    let c = 0;
    for (let b = bits; b; b &= b - 1) c++;
    if (c === n) out.push(String.fromCharCode(0x2800 + bits));
  }
  return out;
}

/**
 * Smoke glyphs per density level, faintest first: level k holds every braille
 * pattern with `MIN_DOTS + k` dots. A character climbs the levels by GAINING
 * dots from its own stable dot order (see `smokeGlyph`), so each level's glyph
 * is a superset of the previous one and the particle visibly condenses
 * instead of re-scattering at every level.
 *
 * Invariant: every glyph must be East-Asian-Width NEUTRAL/narrow, never
 * Ambiguous. An Ambiguous glyph (e.g. U+00B7 `·`) renders 2 columns on
 * terminals set to "ambiguous characters are double-width" (common in CJK
 * locales), which breaks the column-width invariant and can wrap a
 * full-width line mid-fade. Braille patterns (U+2800 block) are always 1
 * column. Shade blocks (░▒) read as redaction bars and plain dots read as a
 * loading ellipsis, so neither belongs here.
 */
export const SMOKE_GLYPH_LEVELS: readonly (readonly string[])[] = Array.from(
  { length: MAX_DOTS - MIN_DOTS + 1 },
  (_, k) => brailleWithDots(MIN_DOTS + k),
);

/** Largest fraction by which a character's fade may be shortened. */
export const LIFETIME_JITTER = 0.2;
/** Half-width of the smoke-phase tone offset, in ramp units. */
export const TONE_JITTER = 0.04;

/** Independent seed lanes, so each property varies on its own. */
const LANE_LIFETIME = 0;
const LANE_TONE = 1;
const LANE_GLYPH = 2;
/**
 * Pinned, not derived from the level count: `seedUnit` multiplies by it, so
 * changing it would silently reshuffle every character's lifetime and tone.
 */
const LANE_COUNT = 6;

/**
 * Deterministic unit value in [0, 1) for `seed` on `lane`. A 32-bit integer
 * finalizer (murmur3 fmix32): adjacent seeds give uncorrelated values, which
 * is what keeps neighbouring letters from moving in lockstep.
 */
export function seedUnit(seed: number, lane: number): number {
  let h = (Math.imul(seed | 0, LANE_COUNT) + lane) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** This character's fade length: `base`, shortened by up to LIFETIME_JITTER. */
export function charLifetime(seed: number, base: number): number {
  return base * (1 - LIFETIME_JITTER * seedUnit(seed, LANE_LIFETIME));
}

/** This character's stable order for raising its 8 braille dot bits (Fisher-Yates on its seed). */
function dotOrder(seed: number): number[] {
  const order = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(seedUnit(seed * 8 + i, LANE_GLYPH) * (i + 1));
    const a = order[i] ?? 0;
    order[i] = order[j] ?? 0;
    order[j] = a;
  }
  return order;
}

/**
 * Smoke glyph for progress `p` in [0, 1) through the smoke phase: the first
 * `MIN_DOTS + level` dots of this character's own dot order, so dots only
 * ever accumulate as it condenses.
 */
export function smokeGlyph(p: number, seed: number): string {
  const last = SMOKE_GLYPH_LEVELS.length - 1;
  const level = Math.min(last, Math.max(0, Math.floor(p * SMOKE_GLYPH_LEVELS.length)));
  const order = dotOrder(seed);
  let bits = 0;
  for (let i = 0; i < MIN_DOTS + level; i++) bits |= 1 << (order[i] ?? 0);
  return String.fromCharCode(0x2800 + bits);
}

/** Tone offset in [-TONE_JITTER, TONE_JITTER) for a character still in smoke. */
export function smokeToneOffset(seed: number): number {
  return (seedUnit(seed, LANE_TONE) * 2 - 1) * TONE_JITTER;
}

/**
 * Ease-out cubic on [0, 1]. The letter brightens quickly as it condenses,
 * then decelerates into its settled tone, so the hand-off to the character's
 * own styling lands softly instead of at full speed.
 */
export function easeOutCubic(p: number): number {
  const q = 1 - Math.min(1, Math.max(0, p));
  return 1 - q * q * q;
}

/**
 * Smoothstep on [0, 1]: starts and lands with zero slope. Used for letter
 * blends so the first frame of a fade barely moves (no pop as a letter is
 * born) and the hand-off to the settled color has no visible corner.
 */
export function smoothstep(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
}
