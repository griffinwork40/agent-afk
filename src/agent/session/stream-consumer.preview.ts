import { resolvePreviewTailLines, resolvePreviewHeadLines } from '../../config/bash-preview.js';

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
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts `tailPreview` (last ≤N non-empty lines)
 * and optionally `headPreview` (first ≤M non-empty lines) that `formatOutcome`
 * uses to render an actual head/tail in the scrollback outcome row instead of
 * only a line count. Line counts are configured via `AFK_BASH_PREVIEW_TAIL_LINES`
 * and `AFK_BASH_PREVIEW_HEAD_LINES`.
 */
export function truncateContent(
  content: string,
): {
  content: string;
  truncated: boolean;
  lineCount?: number;
  sizeBytes: number;
  sizeLabel: string;
  tailPreview?: string[];
  headPreview?: string[];
  hiddenLineCount?: number;
} {
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

  const tailLines = resolvePreviewTailLines();
  const headLines = resolvePreviewHeadLines();

  // When head + tail >= total non-empty lines, show all lines without duplication.
  const tailPreview = tailLines > 0 ? nonEmptyLines.slice(-tailLines) : [];
  let headPreview: string[] = [];

  if (headLines > 0) {
    if (headLines + tailLines >= nonEmptyLines.length) {
      // All lines fit — head is everything, tail is omitted to avoid duplicates.
      headPreview = nonEmptyLines;
    } else {
      headPreview = nonEmptyLines.slice(0, headLines);
    }
  }

  // Deduplicate: when all lines fit in headPreview, clear tailPreview.
  const resolvedTailPreview = headLines > 0 && headLines + tailLines >= nonEmptyLines.length
    ? []
    : tailPreview;

  const displayedCount = headPreview.length + resolvedTailPreview.length;

  // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
  // so the UI reads coherently: "N lines, M earlier lines hidden" implies
  // N - M lines are visible in the head/tail preview.
  const hiddenLineCount = lines.length - displayedCount;

  const previewResult = {
    lineCount: lines.length,
    sizeBytes,
    sizeLabel,
    tailPreview: resolvedTailPreview.length > 0 ? resolvedTailPreview : undefined,
    headPreview: headPreview.length > 0 ? headPreview : undefined,
    hiddenLineCount,
  };

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return { content, truncated: false, ...previewResult };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, ...previewResult };
}
