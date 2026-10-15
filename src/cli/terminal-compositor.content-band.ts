/**
 * Compositor-side accessor for the centered content band (AFK_CENTER_CONTENT).
 *
 * Contract: every compositor paint, wrap, and row-count site derives the band
 * from the compositor's OWN stdout width — never from the zero-arg
 * `contentMargin()`, which reads `process.stdout.columns` and silently yields
 * margin 0 (or a mismatched margin) whenever the compositor drives a different
 * stream (mock stdout in tests, a non-process TTY).
 *
 * Invariant (wrap vs paint): committed text is WRAPPED at `band.width` and the
 * margin is added at PAINT time, so `margin + row` always fits `cols`. With
 * centering off the band is the identity (`margin ''`, `width === cols`), so
 * the default path is byte-identical to the pre-band code.
 */
import { contentBand, type ContentBand } from './render/measure.js';

export function compositorBand(stdout: { readonly columns?: number }): ContentBand {
  // No clamp: centering-off must return `width === columns` exactly, matching
  // the pre-band `stdout.columns ?? 80` reads byte-for-byte (even a 0 width).
  return contentBand(stdout.columns ?? 80);
}
