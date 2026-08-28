import { palette } from '../palette.js';
import { formatElapsed } from './utils.js';

// ─── Stream Progress ─────────────────────────────────────────────────────────

/**
 * Spinner glyphs for the progress line — 10-frame cycle.
 * Caller drives the tick by incrementing `spinnerFrame`.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Render a single-line progress indicator for a streaming operation.
 *
 * Visual output:
 *   ⠹ Generating…  1.2k tokens  4.7s
 *
 * Designed for the OverlayComposer live region — called on every repaint
 * tick. The caller is responsible for incrementing `spinnerFrame` to
 * animate the spinner (typically via a setInterval).
 *
 * @param spec - Progress configuration.
 * @returns Single-line ANSI string.
 */
export function streamProgress(spec: StreamProgressSpec): string {
  const frame = SPINNER_FRAMES[spec.spinnerFrame % SPINNER_FRAMES.length]!;
  const spinner = palette.brand(frame);

  const label = palette.bold(spec.label);

  const parts = [spinner, label];

  if (spec.tokenCount != null) {
    parts.push(palette.dim(formatTokenCount(spec.tokenCount)));
  }

  if (spec.costCents != null && spec.costCents > 0) {
    parts.push(palette.dim(formatCost(spec.costCents)));
  }

  parts.push(palette.dim(formatElapsed(spec.elapsedMs)));

  return parts.join('  ');
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamProgressSpec {
  /** Human-readable label — e.g. "Generating…", "Running tests…". */
  label: string;
  /** Current spinner frame index (caller increments). */
  spinnerFrame: number;
  /** Elapsed time in milliseconds. */
  elapsedMs: number;
  /** Accumulated token count (input + output). */
  tokenCount?: number;
  /** Cost in cents (displayed as $0.XX). */
  costCents?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format token count with k/M suffixes. */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}

/** Format cost in cents as dollars. */
function formatCost(cents: number): string {
  if (cents < 1) return `$${(cents / 100).toFixed(4)}`;
  if (cents < 100) return `$${(cents / 100).toFixed(2)}`;
  return `$${(cents / 100).toFixed(0)}`;
}
