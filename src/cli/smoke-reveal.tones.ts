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
import { getActiveTheme, type ThemeName } from './theme.js';

type Rgb = readonly [number, number, number];

/** Ramp endpoints per theme: [near-background, near-foreground]. */
const ENDPOINTS: Record<ThemeName, readonly [Rgb, Rgb]> = {
  dark: [[48, 48, 54], [214, 214, 220]],
  light: [[226, 226, 226], [58, 58, 58]],
  // Umber background is #19120D; its ansi7 white is #D3CDC5.
  umber: [[54, 43, 35], [211, 205, 197]],
};

/** Number of quantized stops. Enough for a smooth fade, small enough to cache. */
export const TONE_STEPS = 16;

const cache = new Map<ThemeName, ChalkInstance[]>();

function buildRamp(theme: ThemeName): ChalkInstance[] {
  const [from, to] = ENDPOINTS[theme];
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
  const theme = getActiveTheme();
  let ramp = cache.get(theme);
  if (!ramp) {
    ramp = buildRamp(theme);
    cache.set(theme, ramp);
  }
  const clamped = Math.min(1, Math.max(0, t));
  const idx = Math.round(clamped * (TONE_STEPS - 1));
  return ramp[idx] ?? ramp[ramp.length - 1] ?? chalk;
}

/** Test seam: drop cached ramps (e.g. after changing `chalk.level`). */
export function resetSmokeToneCache(): void {
  cache.clear();
}
