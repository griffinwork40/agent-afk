/**
 * Configurable bash output preview — head and tail line selection for the TUI
 * outcome preview row.
 *
 * ## Why a separate module?
 *
 * PR #1500 introduced a compact 7-line tail-first preview. Issue #1507 makes
 * the counts configurable via `AFK_BASH_PREVIEW_TAIL_LINES` (default 7) and
 * `AFK_BASH_PREVIEW_HEAD_LINES` (default 0). This module owns:
 *   - Reading those env vars through the canonical `env` read-point.
 *   - The `selectPreviewLines` pure function for unit testing.
 *   - The `readPreviewConfig` helper that resolves and validates the env values.
 *
 * ## Configuration precedence
 *   1. `AFK_BASH_PREVIEW_TAIL_LINES` / `AFK_BASH_PREVIEW_HEAD_LINES` env vars
 *   2. Defaults: tail = 7, head = 0
 *
 * ## Overlap handling
 *
 * When `headCount + tailCount >= lines.length`, all lines are returned without a
 * hidden-line notice (no duplication). The caller computes `hiddenLineCount` from
 * `lines.length - selected.length`.
 */

import { env } from '../../config/env.js';

/** Validated, resolved preview configuration. */
export interface PreviewConfig {
  /** Number of leading non-empty lines in the head block. 0 = no head block. */
  headCount: number;
  /** Number of trailing non-empty lines in the tail block. */
  tailCount: number;
}

/** Accepted range for both head and tail counts. */
const MIN_LINES = 0;
const MAX_LINES = 200;
const DEFAULT_TAIL = 7;
const DEFAULT_HEAD = 0;

/**
 * Parse and clamp a raw env var value into a valid line count.
 *
 * Returns `defaultValue` when `raw` is undefined, empty, non-numeric, negative,
 * or out of [0, 200] — consistent with the pattern used by other numeric env
 * vars in this codebase (e.g. AFK_MAX_NESTING_DEPTH).
 */
export function parseLineCount(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < MIN_LINES || n > MAX_LINES) return defaultValue;
  return n;
}

/**
 * Read and validate `AFK_BASH_PREVIEW_TAIL_LINES` and
 * `AFK_BASH_PREVIEW_HEAD_LINES` from the canonical env read-point.
 *
 * Always returns a valid `PreviewConfig` — invalid or out-of-range values fall
 * back to defaults without throwing.
 */
export function readPreviewConfig(): PreviewConfig {
  return {
    tailCount: parseLineCount(env.AFK_BASH_PREVIEW_TAIL_LINES, DEFAULT_TAIL),
    headCount: parseLineCount(env.AFK_BASH_PREVIEW_HEAD_LINES, DEFAULT_HEAD),
  };
}

/**
 * Select the lines to display in the TUI outcome preview.
 *
 * @param lines     The complete array of non-empty output lines to sample from.
 * @param headCount Number of leading lines to include. 0 = no head block.
 * @param tailCount Number of trailing lines to include.
 * @returns         `{ head, tail }` where both arrays are slices of `lines` with
 *                  no duplicates even when the ranges overlap. When
 *                  `headCount + tailCount >= lines.length` the arrays together
 *                  cover every line exactly once (split at the overlap boundary).
 *
 * The caller is responsible for computing `hiddenLineCount`:
 *   `lines.length - (head.length + tail.length)`
 *
 * It is always >= 0 because the two slices never overlap.
 */
export function selectPreviewLines(
  lines: string[],
  headCount: number,
  tailCount: number,
): { head: string[]; tail: string[] } {
  if (lines.length === 0) return { head: [], tail: [] };

  // When head + tail covers everything, return the full set without duplication.
  // Split at the head boundary so head + tail = all lines with no overlap.
  if (headCount + tailCount >= lines.length) {
    const head = lines.slice(0, headCount);
    const tail = lines.slice(headCount);
    return { head, tail };
  }

  const head = headCount > 0 ? lines.slice(0, headCount) : [];
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
  return { head, tail };
}
