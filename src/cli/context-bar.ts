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
 * - Color: the filled run + percent are threshold-toned (chrome when ratio ≤ 0.5,
 *   orange > 0.5, red > 0.8); the brackets + empty track always recede in dim
 *   `meta`, so even a low-ratio bar reads as a real control instead of an empty box
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

  // Contract: the bar is composed from TWO tones rather than wrapped in one.
  // The filled run carries a threshold-graded "signal" tone that stays VISIBLE
  // even at a low ratio (so a nearly-empty bar reads as a real control, not an
  // empty box), while the brackets + empty track recede in `meta`. Previously
  // the whole `[bar] NN% counts` string was wrapped in a single `color` that
  // collapsed to near-invisible `meta` for every ratio <= 0.5 — that is what
  // made a low-context bar look broken/unfinished. All tones are EXISTING
  // palette roles (no new hardcoded hex): chrome (calm, ratio <= 0.5), warning
  // (> 0.5), error (> 0.8).
  const fillTone =
    ratio > 0.8 ? palette.error : ratio > 0.5 ? palette.warning : palette.chrome;
  const trackTone = palette.meta;

  // Render bar: 20 cells, proportional fill. Geometry unchanged — only the
  // per-run coloring differs (filled = signal tone, brackets/track = recessive).
  const barWidth = 20;
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;
  const bar =
    trackTone('[') +
    fillTone('█'.repeat(filled)) +
    trackTone('░'.repeat(empty)) +
    trackTone(']');

  // Percent shares the fill's threshold tone (a near-full context glows red);
  // counts stay recessive. The `*Plain` variants below drive the width math and
  // must stay ANSI-free so displayWidth measures the real cell count.
  const percentPlain = Math.round(ratio * 100) + '%';
  const percent = fillTone(percentPlain);

  let countsPlain = '';
  if (opts.used !== undefined && opts.limit !== undefined) {
    countsPlain = formatTokens(opts.used) + '/' + formatTokens(opts.limit);
  }
  const counts = palette.meta(countsPlain);

  // Build plain (uncolored) forms to calculate widths
  const barPlain = '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  const fullFormPlain = countsPlain ? `${barPlain} ${percentPlain} ${countsPlain}` : `${barPlain} ${percentPlain}`;
  const degradedFormPlain = `${barPlain} ${percentPlain}`;
  const minimalFormPlain = `ctx ${percentPlain}`;

  // Colored assemblies mirroring each plain form 1:1.
  const fullForm = countsPlain ? `${bar} ${percent} ${counts}` : `${bar} ${percent}`;
  const degradedForm = `${bar} ${percent}`;
  const minimalForm = palette.meta('ctx ') + percent;

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
    return sparklinePrefix + fullForm;
  }

  // Try degraded form (with bar, no counts)
  // Requires sufficient margin; 26-char form needs width > ~32 to feel comfortable
  if (displayWidth(degradedFormPlain) <= contentWidth && contentWidth > 32) {
    return sparklinePrefix + degradedForm;
  }

  // Fall back to minimal form (no bar)
  if (displayWidth(minimalFormPlain) <= contentWidth) {
    return sparklinePrefix + minimalForm;
  }

  // If even the minimal form doesn't fit, try truncating it
  if (opts.width > 0) {
    const minimalWithSparkline = sparklinePrefix + minimalForm;
    return truncateDisplayWidth(minimalWithSparkline, opts.width);
  }

  // Last resort: return just the percent as a bare minimum,
  // even if width is too constrained to fit nicely
  return percent;
}
