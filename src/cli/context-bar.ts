/**
 * Lane B: Pure helper that renders a single-tone context-usage progress bar.
 *
 * Exports `formatContextBar` which produces a colored progress bar that adapts
 * to available display width.
 */

import { palette } from './palette.js';
import { formatTokens } from './format-utils.js';
import { displayWidth, truncateDisplayWidth } from './display.js';

export interface ContextBarOpts {
  ratio: number;           // [0, 1]; clamp out-of-range
  used?: number;           // absolute tokens used (display)
  limit?: number;          // absolute context window (display)
  sparkline?: string;      // pre-rendered sparkline string, prepended
  width: number;           // available column budget for the entire field
}

/**
 * Format a context-usage progress bar.
 *
 * Behavior:
 * - Color: ratio > 0.8 → red; > 0.5 → orange; else dim
 * - Bar: 20 cells of █ filled vs ░ empty proportional to ratio, wrapped in [ ]
 * - Counts: formatTokens(used) + '/' + formatTokens(limit)
 * - Width-adaptive degradation:
 *   1. Full form: [BAR] NN% USED/LIMIT
 *   2. Degraded: [BAR] NN% (drop counts)
 *   3. Minimal: ctx NN% (drop bar)
 * - Sparkline: if provided, prepend with single space separator, colored dim
 * - Percent: integer Math.round(ratio * 100) followed by %
 */
export function formatContextBar(opts: ContextBarOpts): string {
  // Clamp ratio to [0, 1]
  const ratio = Math.max(0, Math.min(1, opts.ratio));

  // Determine color based on ratio threshold
  const color =
    ratio > 0.8
      ? palette.error    // red
      : ratio > 0.5
      ? palette.warning  // yellow/orange
      : palette.meta;    // bright-black

  // Render bar: 20 cells, proportional fill
  const barWidth = 20;
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';

  // Format percent
  const percent = Math.round(ratio * 100) + '%';

  // Format counts if provided
  let counts = '';
  if (opts.used !== undefined && opts.limit !== undefined) {
    counts = formatTokens(opts.used) + '/' + formatTokens(opts.limit);
  }

  // Build plain (uncolored) forms to calculate widths
  const fullFormPlain = counts ? `${bar} ${percent} ${counts}` : `${bar} ${percent}`;
  const degradedFormPlain = `${bar} ${percent}`;
  const minimalFormPlain = `ctx ${percent}`;

  // Sparkline is always dimly colored with meta (blackBright) tone
  const sparklinePrefix = opts.sparkline ? palette.meta(opts.sparkline) + ' ' : '';
  const sparklinePrefixWidth = opts.sparkline ? displayWidth(opts.sparkline) + 1 : 0;

  // Calculate available width for the content (after sparkline)
  const contentWidth = Math.max(0, opts.width - sparklinePrefixWidth);

  // Degradation thresholds (with margin to avoid cramped appearance):
  // - Full form (with counts) needs width > 90
  // - Degraded form (bar + percent) needs width > 26 (degraded width)
  // - Minimal form always fits if content width allows

  // Try full form first (requires generous margin)
  if (displayWidth(fullFormPlain) <= contentWidth && contentWidth > 90) {
    return sparklinePrefix + color(fullFormPlain);
  }

  // Try degraded form (with bar, no counts)
  // Requires sufficient margin; 26-char form needs width > ~32 to feel comfortable
  if (displayWidth(degradedFormPlain) <= contentWidth && contentWidth > 32) {
    return sparklinePrefix + color(degradedFormPlain);
  }

  // Fall back to minimal form (no bar)
  if (displayWidth(minimalFormPlain) <= contentWidth) {
    return sparklinePrefix + color(minimalFormPlain);
  }

  // If even the minimal form doesn't fit, try truncating it
  if (opts.width > 0) {
    const minimalWithSparkline = sparklinePrefix + color(minimalFormPlain);
    return truncateDisplayWidth(minimalWithSparkline, opts.width);
  }

  // Last resort: return just the percent as a bare minimum,
  // even if width is too constrained to fit nicely
  return color(percent);
}
