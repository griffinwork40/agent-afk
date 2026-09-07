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

/** Default number of tail lines shown in the TUI outcome preview. */
const DEFAULT_TAIL_PREVIEW_LINES = 7;
/** Default number of head lines shown in the TUI outcome preview. */
const DEFAULT_HEAD_PREVIEW_LINES = 0;
/** Accepted range for both head and tail line counts. */
const PREVIEW_LINES_MIN = 0;
const PREVIEW_LINES_MAX = 50;

/**
 * Parse a preview line-count from an env-var string, clamping to the accepted
 * range. Returns `defaultValue` when the raw string is absent, non-numeric,
 * non-integer, or out of range.
 */
function parsePreviewLineCount(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < PREVIEW_LINES_MIN || n > PREVIEW_LINES_MAX) {
    return defaultValue;
  }
  return n;
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * configurable via AFK_BASH_PREVIEW_TAIL_LINES, default 7) and optionally a
 * `headPreview` (first ≤M non-empty lines, configurable via
 * AFK_BASH_PREVIEW_HEAD_LINES, default 0) that `formatOutcome` uses to render
 * actual head/tail lines in the scrollback outcome row instead of only a line
 * count.
 */
export function truncateContent(
  content: string,
): { content: string; truncated: boolean; lineCount?: number; sizeBytes: number; sizeLabel: string; headPreview?: string[]; tailPreview?: string[]; hiddenLineCount?: number } {
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

  // Multi-line path: always extract lineCount and preview arrays so the TUI
  // can render actual lines regardless of total character count.
  // Short multi-line output (≤80 chars) is shown verbatim as the preview
  // (no display truncation needed), but we still expose lineCount+tailPreview
  // so the outcome row renders the tail preview block rather than hiding it.
  const tailCount = parsePreviewLineCount(env.AFK_BASH_PREVIEW_TAIL_LINES, DEFAULT_TAIL_PREVIEW_LINES);
  const headCount = parsePreviewLineCount(env.AFK_BASH_PREVIEW_HEAD_LINES, DEFAULT_HEAD_PREVIEW_LINES);

  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  // When head + tail >= total non-empty lines, show everything without
  // duplication — equivalent to deduplicating the two windows.
  const totalNonEmpty = nonEmptyLines.length;
  let headPreview: string[];
  let tailPreview: string[];

  if (headCount + tailCount >= totalNonEmpty) {
    // All non-empty lines fit within the combined budget — show all, no overlap.
    headPreview = headCount > 0 ? nonEmptyLines : [];
    tailPreview = headCount > 0 ? [] : nonEmptyLines.slice(-tailCount);
  } else {
    headPreview = headCount > 0 ? nonEmptyLines.slice(0, headCount) : [];
    tailPreview = tailCount > 0 ? nonEmptyLines.slice(-tailCount) : [];
  }

  // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
  // so the UI reads coherently: "N lines, M earlier lines hidden" implies
  // N - M lines are visible across both previews.
  const hiddenLineCount = lines.length - headPreview.length - tailPreview.length;

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // preview arrays are still set so formatOutcome renders the preview block.
    return {
      content,
      truncated: false,
      lineCount: lines.length,
      sizeBytes,
      sizeLabel,
      ...(headPreview.length > 0 && { headPreview }),
      tailPreview: tailPreview.length > 0 ? tailPreview : undefined,
      hiddenLineCount,
    };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return {
    content: truncatedContent,
    truncated: true,
    lineCount: lines.length,
    sizeBytes,
    sizeLabel,
    ...(headPreview.length > 0 && { headPreview }),
    tailPreview: tailPreview.length > 0 ? tailPreview : undefined,
    hiddenLineCount,
  };
}
