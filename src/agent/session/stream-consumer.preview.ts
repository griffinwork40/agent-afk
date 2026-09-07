import { env } from '../../config/env.js';

/** Display-only output sizing and tail extraction. */
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

/**
 * Read AFK_BASH_PREVIEW_TAIL_LINES and AFK_BASH_PREVIEW_HEAD_LINES from the
 * env registry and return validated, bounded values.
 *
 * Precedence (highest → lowest):
 *   1. AFK_BASH_PREVIEW_TAIL_LINES / AFK_BASH_PREVIEW_HEAD_LINES (env vars)
 *   2. Hardcoded defaults (tailLines=7, headLines=0)
 *
 * Invalid (non-integer, NaN) or out-of-range values silently fall back to the
 * defaults. Tail range: 1–50. Head range: 0–50.
 */
function getPreviewConfig(): { tailLines: number; headLines: number } {
  const DEFAULT_TAIL = 7;
  const DEFAULT_HEAD = 0;

  let tailLines = DEFAULT_TAIL;
  const rawTail = env.AFK_BASH_PREVIEW_TAIL_LINES;
  if (rawTail !== undefined) {
    const parsed = parseInt(rawTail, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) tailLines = parsed;
  }

  let headLines = DEFAULT_HEAD;
  const rawHead = env.AFK_BASH_PREVIEW_HEAD_LINES;
  if (rawHead !== undefined) {
    const parsed = parseInt(rawHead, 10);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 50) headLines = parsed;
  }

  return { tailLines, headLines };
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * optionally prefixed with head lines) that `formatOutcome` uses to render an
 * actual tail in the scrollback outcome row instead of only a line count.
 *
 * Preview size is configurable via AFK_BASH_PREVIEW_TAIL_LINES (default 7)
 * and AFK_BASH_PREVIEW_HEAD_LINES (default 0). When head + tail ≥ total
 * non-empty lines, all lines are shown without duplication.
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
  // Short multi-line output (≤80 chars) is shown verbatim as the preview
  // (no display truncation needed), but we still expose lineCount+tailPreview
  // so the outcome row renders the tail preview block rather than hiding it.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  const { tailLines, headLines } = getPreviewConfig();

  let tailPreview: string[];
  if (headLines > 0 && headLines + tailLines >= nonEmptyLines.length) {
    // Head + tail would cover everything — show all lines without duplication.
    tailPreview = nonEmptyLines.slice();
  } else if (headLines > 0) {
    // Both head and tail sections; they do not overlap.
    const head = nonEmptyLines.slice(0, headLines);
    const tail = nonEmptyLines.slice(-tailLines);
    tailPreview = [...head, ...tail];
  } else {
    // Default: tail only.
    tailPreview = nonEmptyLines.slice(-tailLines);
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
