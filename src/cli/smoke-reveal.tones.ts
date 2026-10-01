/**
 * Smoke-text tone ramp: a theme-aware gradient from "almost the background"
 * to "almost the foreground", used to fade characters in as they condense.
 *
 * Sanctioned palette extension (allowlisted in `scripts/audit-chalk-usage.ts`,
 * same precedent as the welcome-banner gradient): a single flat palette role
 * cannot express a continuous ramp, so this module builds `chalk.rgb` stops
 * itself.
 *
 * Invariant: stops are built LAZILY on first use and cached per theme. The
 * chalk color-space is resolved when `chalk.rgb()` is called (see the
 * `palette.ts` header), so building at import time would freeze the ramp at
 * whatever level chalk auto-detected before `configureColor()` ran.
 *
 * @module cli/smoke-reveal.tones
 */

import chalk, { type ChalkInstance } from 'chalk';
import { getTerminalColors } from './terminal-colors.js';
import { getActiveTheme, type ThemeName } from './theme.js';

export type Rgb = readonly [number, number, number];

/** Ramp endpoints per theme: [near-background, near-foreground]. */
const ENDPOINTS: Record<ThemeName, readonly [Rgb, Rgb]> = {
  dark: [[48, 48, 54], [214, 214, 220]],
  light: [[226, 226, 226], [58, 58, 58]],
  // Umber background is #19120D; its ansi7 white is #D3CDC5.
  umber: [[54, 43, 35], [211, 205, 197]],
};

/** Number of quantized stops. Enough for a smooth fade, small enough to cache. */
export const TONE_STEPS = 16;

const cache = new Map<string, ChalkInstance[]>();

/**
 * Ramp endpoints in use: the terminal's own background and foreground when
 * they were discovered (see terminal-colors.ts), else the theme table. The
 * real pair is what makes a fade land exactly on the settled color.
 */
export function rampEndpoints(): readonly [Rgb, Rgb] {
  const found = getTerminalColors();
  const [from, to] = ENDPOINTS[getActiveTheme()];
  return [found?.bg ?? from, found?.fg ?? to];
}

function buildRamp([from, to]: readonly [Rgb, Rgb]): ChalkInstance[] {
  const stops: ChalkInstance[] = [];
  for (let i = 0; i < TONE_STEPS; i++) {
    const t = i / (TONE_STEPS - 1);
    const c = from.map((v, k) => Math.round(v + ((to[k] ?? v) - v) * t));
    stops.push(chalk.rgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0));
  }
  return stops;
}

/**
 * Tone for fade progress `t` in [0, 1] (0 = faintest, 1 = brightest).
 * Out-of-range input is clamped.
 */
export function smokeTone(t: number): ChalkInstance {
  const ends = rampEndpoints();
  // Keyed by the endpoints themselves, so discovery (or a theme switch)
  // after the first paint can never leave a stale ramp in place.
  const key = ends.flat().join(',');
  let ramp = cache.get(key);
  if (!ramp) {
    ramp = buildRamp(ends);
    cache.set(key, ramp);
  }
  const clamped = Math.min(1, Math.max(0, t));
  const idx = Math.round(clamped * (TONE_STEPS - 1));
  return ramp[idx] ?? ramp[ramp.length - 1] ?? chalk;
}

/**
 * Unquantized RGB for ramp position `t` in [0, 1] on the active theme. The
 * ink fade interpolates from this toward a character's own color, so it needs
 * the raw endpoint math rather than a cached chalk stop.
 */
export function toneRgb(t: number): Rgb {
  const [from, to] = rampEndpoints();
  const c = Math.min(1, Math.max(0, t));
  return [
    Math.round(from[0] + (to[0] - from[0]) * c),
    Math.round(from[1] + (to[1] - from[1]) * c),
    Math.round(from[2] + (to[2] - from[2]) * c),
  ];
}

/** Test seam: drop cached ramps (e.g. after changing `chalk.level`). */
export function resetSmokeToneCache(): void {
  cache.clear();
}
