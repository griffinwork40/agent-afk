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

import { readPreviewConfig, selectPreviewLines } from './bash-preview.js';

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * where N is `AFK_BASH_PREVIEW_TAIL_LINES`, default 7) and an optional
 * `headPreview` (first ≤M non-empty lines, where M is
 * `AFK_BASH_PREVIEW_HEAD_LINES`, default 0) that `formatOutcome` uses to
 * render an actual head+tail in the scrollback outcome row instead of only a
 * line count. The hidden-line count is derived from the actual displayed
 * selection so the UI always reads coherently.
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
  const { tailCount, headCount } = readPreviewConfig();
  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  const { head: headPreview, tail: tailPreview } = selectPreviewLines(nonEmptyLines, headCount, tailCount);

  // Contract: hiddenLineCount is the non-empty lines NOT shown in either block,
  // using lines.length (total physical lines) as the denominator so the UI
  // reads coherently: "N lines, M earlier lines hidden" implies the rest are
  // visible in the preview blocks.
  const shownCount = headPreview.length + tailPreview.length;
  const hiddenLineCount = lines.length - shownCount;

  // Build the combined preview for the outcome row: head block (if any),
  // then tail block. The caller (formatOutcome) renders headPreview as leading
  // lines and tailPreview as trailing lines; we pass tailPreview through the
  // existing tailPreview field and headPreview via the same array convention
  // (prepended) to avoid changing the ToolResultChunk shape.
  // Since formatOutcome only has tailPreview today, we concatenate head + tail
  // into a single ordered array. hiddenLineCount reflects what is hidden between
  // them when head and tail do not cover everything.
  const combinedPreview = [...headPreview, ...tailPreview];

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return { content, truncated: false, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview: combinedPreview, hiddenLineCount };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, lineCount: lines.length, sizeBytes, sizeLabel, tailPreview: combinedPreview, hiddenLineCount };
}
