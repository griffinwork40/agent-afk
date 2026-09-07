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

/** Default tail line count when no config is present. */
const DEFAULT_TAIL_LINES = 7;
/** Default head line count when no config is present. */
const DEFAULT_HEAD_LINES = 0;
/** Maximum permitted value for head/tail counts. */
const MAX_PREVIEW_LINES = 200;

/**
 * Parse and clamp a preview line count from a raw env-var string.
 * Returns `defaultValue` for missing, non-numeric, non-integer, or
 * out-of-range inputs.
 *
 * Config precedence: env var (AFK_BASH_PREVIEW_*) overrides afk.config.json.
 * This function handles only the env-var layer; callers pass the raw string
 * already read through the canonical `env` object (never direct process.env).
 */
function parsePreviewLineCount(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultValue;
  if (n < 0) return defaultValue;
  return Math.min(n, MAX_PREVIEW_LINES);
}

/**
 * Return the effective tail line count for the bash output preview.
 *
 * Precedence (highest → lowest):
 *   1. AFK_BASH_PREVIEW_TAIL_LINES env var (via canonical `env` object)
 *   2. bash.previewTailLines in afk.config.json (not yet wired — placeholder)
 *   3. Hard default of 7
 */
export function getPreviewTailLines(): number {
  return parsePreviewLineCount(env.AFK_BASH_PREVIEW_TAIL_LINES, DEFAULT_TAIL_LINES);
}

/**
 * Return the effective head line count for the bash output preview.
 *
 * Precedence (highest → lowest):
 *   1. AFK_BASH_PREVIEW_HEAD_LINES env var (via canonical `env` object)
 *   2. bash.previewHeadLines in afk.config.json (not yet wired — placeholder)
 *   3. Hard default of 0 (head section disabled)
 */
export function getPreviewHeadLines(): number {
  return parsePreviewLineCount(env.AFK_BASH_PREVIEW_HEAD_LINES, DEFAULT_HEAD_LINES);
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * N from AFK_BASH_PREVIEW_TAIL_LINES or default 7) and optionally a head
 * section (AFK_BASH_PREVIEW_HEAD_LINES, default 0) that `formatOutcome` uses
 * to render an actual preview block in the scrollback outcome row.
 *
 * When head + tail together cover all non-empty lines, no separator is needed
 * and hiddenLineCount is zero. When they overlap (head + tail ≥ total), all
 * lines are shown exactly once (deduplication via splice). hiddenLineCount is
 * always computed from `lines.length` (raw split count) minus the number of
 * non-empty lines actually shown, keeping the denominator consistent with
 * lineCount so "N lines, M earlier lines hidden" stays coherent.
 */
export function truncateContent(
  content: string,
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
  const tailLines = getPreviewTailLines();
  const headLines = getPreviewHeadLines();

  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  const total = nonEmptyLines.length;

  let tailPreview: string[];
  if (headLines === 0) {
    // No head — simple tail slice (original behaviour).
    tailPreview = nonEmptyLines.slice(-tailLines);
  } else if (headLines + tailLines >= total) {
    // Head + tail covers everything — show all, no separator needed.
    tailPreview = nonEmptyLines.slice();
  } else {
    // Both head and tail are present and do not overlap.
    const head = nonEmptyLines.slice(0, headLines);
    const tail = nonEmptyLines.slice(-tailLines);
    tailPreview = [...head, ...tail];
  }

  // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
  // so the UI reads coherently: "N lines, M earlier lines hidden" implies
  // N - M lines are visible in the preview.
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
