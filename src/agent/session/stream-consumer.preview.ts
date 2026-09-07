/** Display-only output sizing and tail extraction. */
import { resolvePreviewLineCounts } from './preview-config.js';

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

export interface TruncateResult {
  content: string;
  truncated: boolean;
  lineCount?: number;
  sizeBytes: number;
  sizeLabel: string;
  /** Last ≤N non-empty lines for the TUI outcome tail block. */
  tailPreview?: string[];
  /** First ≤N non-empty lines for the TUI outcome head block (when configured). */
  headPreview?: string[];
  /**
   * Lines omitted from the displayed selection. Denominator is `lines.length`
   * so the UI reads coherently: "N lines, M earlier lines hidden" implies
   * N - M lines visible.
   */
  hiddenLineCount?: number;
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts `tailPreview` (last ≤N non-empty lines)
 * and optionally `headPreview` (first ≤N non-empty lines) for the scrollback
 * outcome row. Line counts are controlled by AFK_BASH_PREVIEW_TAIL_LINES and
 * AFK_BASH_PREVIEW_HEAD_LINES; defaults are 7 and 0 respectively.
 *
 * When head + tail ≥ total non-empty lines, all lines are shown via tailPreview
 * with headPreview omitted and hiddenLineCount set to 0 (no duplication).
 */
export function truncateContent(
  content: string,
  config?: { tailLines?: number; headLines?: number },
): TruncateResult {
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

  // Resolve line counts: explicit config overrides env-based resolver.
  const resolved = resolvePreviewLineCounts();
  const tailLines = config?.tailLines ?? resolved.tailLines;
  const headLines = config?.headLines ?? resolved.headLines;

  // Multi-line path: always extract lineCount and tailPreview so the TUI can
  // render the actual tail lines regardless of total character count.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  let tailPreview: string[];
  let headPreview: string[] | undefined;
  let hiddenLineCount: number;

  if (headLines > 0 && headLines + tailLines >= nonEmptyLines.length) {
    // Head + tail covers all lines — show everything via tailPreview,
    // no head block needed (avoids duplication).
    tailPreview = nonEmptyLines;
    headPreview = undefined;
    // Contract: hiddenLineCount vs lines.length (total lines including empty).
    hiddenLineCount = lines.length - nonEmptyLines.length;
  } else if (headLines > 0) {
    // Partial overlap avoided: head and tail are disjoint.
    headPreview = nonEmptyLines.slice(0, headLines);
    tailPreview = nonEmptyLines.slice(-tailLines);
    // Hidden = total lines minus the displayed non-empty selection.
    hiddenLineCount = lines.length - (headPreview.length + tailPreview.length);
  } else {
    // No head block — tail only (original behaviour).
    tailPreview = nonEmptyLines.slice(-tailLines);
    headPreview = undefined;
    // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
    // so the UI reads coherently: "N lines, M earlier lines hidden" implies
    // N - M lines are visible in the tail preview.
    hiddenLineCount = lines.length - tailPreview.length;
  }

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return { content, truncated: false, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview, headPreview, hiddenLineCount };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview, headPreview, hiddenLineCount };
}
