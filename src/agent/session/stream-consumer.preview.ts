/** Display-only output sizing and tail extraction. */

import { env } from '../../config/env.js';

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return kb % 1 === 0 ? `${Math.floor(kb)}KB` : `${kb.toFixed(1)}KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return mb % 1 === 0 ? `${Math.floor(mb)}MB` : `${mb.toFixed(1)}MB`;
  }
  const gb = mb / 1024;
  return gb % 1 === 0 ? `${Math.floor(gb)}GB` : `${gb.toFixed(1)}GB`;
}

/** Default tail preview line count when no configuration is provided. */
const DEFAULT_TAIL_LINES = 7;
/** Default head preview line count (off by default). */
const DEFAULT_HEAD_LINES = 0;
/** Valid range for preview line counts. */
const PREVIEW_LINES_MIN = 0;
const PREVIEW_LINES_MAX = 200;

/**
 * Parse and clamp a raw string value to a bounded integer in [min, max].
 * Returns `fallback` when the raw value is absent, non-numeric, or non-finite.
 */
function parsePreviewCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(PREVIEW_LINES_MAX, Math.max(PREVIEW_LINES_MIN, n));
}

/**
 * Resolve the effective tail-line count for bash output previews.
 *
 * Precedence (highest to lowest):
 *   1. `AFK_BASH_PREVIEW_TAIL` environment variable
 *   2. `tailLinesOverride` passed by the caller (e.g. from afk.config.json)
 *   3. Hard default (7)
 */
function resolveTailLines(tailLinesOverride?: number): number {
  const fromEnv = env.AFK_BASH_PREVIEW_TAIL;
  if (fromEnv !== undefined) {
    return parsePreviewCount(fromEnv, DEFAULT_TAIL_LINES);
  }
  if (tailLinesOverride !== undefined && Number.isFinite(tailLinesOverride)) {
    return Math.min(PREVIEW_LINES_MAX, Math.max(PREVIEW_LINES_MIN, Math.trunc(tailLinesOverride)));
  }
  return DEFAULT_TAIL_LINES;
}

/**
 * Resolve the effective head-line count for bash output previews.
 *
 * Precedence (highest to lowest):
 *   1. `AFK_BASH_PREVIEW_HEAD` environment variable
 *   2. `headLinesOverride` passed by the caller (e.g. from afk.config.json)
 *   3. Hard default (0 — head preview disabled)
 */
function resolveHeadLines(headLinesOverride?: number): number {
  const fromEnv = env.AFK_BASH_PREVIEW_HEAD;
  if (fromEnv !== undefined) {
    return parsePreviewCount(fromEnv, DEFAULT_HEAD_LINES);
  }
  if (headLinesOverride !== undefined && Number.isFinite(headLinesOverride)) {
    return Math.min(PREVIEW_LINES_MAX, Math.max(PREVIEW_LINES_MIN, Math.trunc(headLinesOverride)));
  }
  return DEFAULT_HEAD_LINES;
}

/** Options for configuring the preview line counts. */
export interface PreviewOptions {
  /** Number of tail lines to show. Env var AFK_BASH_PREVIEW_TAIL takes precedence. */
  tailLines?: number;
  /** Number of head lines to show. Env var AFK_BASH_PREVIEW_HEAD takes precedence. */
  headLines?: number;
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines)
 * and optional `headPreview` (first ≤N non-empty lines) that `formatOutcome`
 * uses to render an actual tail (and optional head) in the scrollback outcome
 * row instead of only a line count.
 *
 * Preview line counts are controlled by:
 *   - `AFK_BASH_PREVIEW_TAIL` / `AFK_BASH_PREVIEW_HEAD` env vars (highest priority)
 *   - `opts.tailLines` / `opts.headLines` (from afk.config.json, caller-supplied)
 *   - Hard defaults: tail = 7, head = 0 (disabled)
 *
 * When head + tail ≥ total non-empty line count, all lines are shown as the
 * tail preview without duplication. The `hiddenLineCount` is computed from
 * the actual displayed selection, not a fixed constant.
 */
export function truncateContent(
  content: string,
  opts?: PreviewOptions,
): { content: string; truncated: boolean; lineCount?: number; sizeBytes: number; sizeLabel: string; tailPreview?: string[]; hiddenLineCount?: number } {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sizeLabel = formatByteSize(sizeBytes);

  const lines = content.split('\n');

  // Single-line path: no lineCount / tailPreview needed.
  if (lines.length <= 1) {
    if (content.length <= 80) {
      return { content, truncated: false, sizeBytes, sizeLabel };
    }
    const truncated = content.substring(0, 80) + '…';
    return { content: truncated, truncated: true, sizeBytes, sizeLabel };
  }

  // Multi-line path: always extract lineCount and tailPreview so the TUI can
  // render the actual tail lines regardless of total character count.
  // Short multi-line output (≤80 chars) is shown verbatim as the preview
  // (no display truncation needed), but we still expose lineCount+tailPreview
  // so the outcome row renders the tail preview block rather than hiding it.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  const tailCount = resolveTailLines(opts?.tailLines);
  const headCount = resolveHeadLines(opts?.headLines);

  let tailPreview: string[];

  if (tailCount === 0 && headCount === 0) {
    // Both disabled — no preview lines at all. Show a zero-element tail
    // so callers know there's content but nothing to display.
    tailPreview = [];
  } else if (tailCount === 0) {
    // Only head requested.
    tailPreview = nonEmptyLines.slice(0, headCount);
  } else if (headCount === 0) {
    // Only tail requested (original behaviour).
    tailPreview = nonEmptyLines.slice(-tailCount);
  } else {
    // Both head and tail requested — merge without duplication.
    const total = nonEmptyLines.length;
    if (headCount + tailCount >= total) {
      // Overlap: show all lines.
      tailPreview = nonEmptyLines.slice();
    } else {
      // No overlap: head lines + tail lines concatenated.
      const head = nonEmptyLines.slice(0, headCount);
      const tail = nonEmptyLines.slice(-tailCount);
      tailPreview = [...head, ...tail];
    }
  }

  // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
  // so the UI reads coherently: "N lines, M earlier lines hidden" implies
  // N - M lines are visible in the tail preview.
  const hiddenLineCount = lines.length - tailPreview.length;

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return { content, truncated: false, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview, hiddenLineCount };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview, hiddenLineCount };
}
