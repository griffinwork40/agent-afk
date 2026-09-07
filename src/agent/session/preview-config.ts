/**
 * Resolver for configurable bash output preview line counts.
 *
 * Reads AFK_BASH_PREVIEW_TAIL_LINES and AFK_BASH_PREVIEW_HEAD_LINES from the
 * canonical env accessor. Invalid or out-of-range values fall back to the
 * documented defaults. Never touches process.env directly.
 */
import { env } from '../../config/env.js';

/** Default number of tail lines in the bash output preview. */
export const DEFAULT_PREVIEW_TAIL_LINES = 7;

/** Default number of head lines in the bash output preview (0 = disabled). */
export const DEFAULT_PREVIEW_HEAD_LINES = 0;

/** Maximum allowed value for either line count setting. */
export const PREVIEW_LINES_CEILING = 50;

export interface PreviewLineCounts {
  tailLines: number;
  headLines: number;
}

/**
 * Resolve the configured preview line counts from environment variables.
 *
 * - AFK_BASH_PREVIEW_TAIL_LINES: positive integer 1–50, default 7.
 * - AFK_BASH_PREVIEW_HEAD_LINES: non-negative integer 0–50, default 0.
 *
 * Any invalid, non-integer, negative (for head), or out-of-range value falls
 * back to the corresponding default. Zero is a valid value for headLines
 * (means "no head block") but not for tailLines (minimum 1).
 */
export function resolvePreviewLineCounts(): PreviewLineCounts {
  return {
    tailLines: resolveTailLines(),
    headLines: resolveHeadLines(),
  };
}

function resolveTailLines(): number {
  const raw = env.AFK_BASH_PREVIEW_TAIL_LINES;
  if (raw === undefined) return DEFAULT_PREVIEW_TAIL_LINES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_PREVIEW_TAIL_LINES;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > PREVIEW_LINES_CEILING) {
    return DEFAULT_PREVIEW_TAIL_LINES;
  }
  return n;
}

function resolveHeadLines(): number {
  const raw = env.AFK_BASH_PREVIEW_HEAD_LINES;
  if (raw === undefined) return DEFAULT_PREVIEW_HEAD_LINES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_PREVIEW_HEAD_LINES;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > PREVIEW_LINES_CEILING) {
    return DEFAULT_PREVIEW_HEAD_LINES;
  }
  return n;
}
