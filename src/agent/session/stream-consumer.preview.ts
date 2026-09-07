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

/** Default number of tail lines shown in the TUI outcome preview. */
const DEFAULT_TAIL_PREVIEW_LINES = 7;
/** Default number of head lines shown in the TUI outcome preview (off). */
const DEFAULT_HEAD_PREVIEW_LINES = 0;
/** Valid range for tail/head line counts (inclusive). */
const PREVIEW_LINES_MIN = 0;
const PREVIEW_LINES_MAX = 50;

/**
 * Clamp a numeric preview-line count to the valid range [0, 50].
 * Falls back to `defaultValue` when the raw value is not a finite integer.
 */
function resolveLineCount(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(PREVIEW_LINES_MIN, Math.min(PREVIEW_LINES_MAX, parsed));
}

/**
 * Read the configured tail/head line counts from env, clamped to valid range.
 * Exported for use by stream-consumer and tests.
 */
export function resolvePreviewConfig(
  rawTail: string | undefined,
  rawHead: string | undefined,
): { tailLines: number; headLines: number } {
  return {
    tailLines: resolveLineCount(rawTail, DEFAULT_TAIL_PREVIEW_LINES),
    headLines: resolveLineCount(rawHead, DEFAULT_HEAD_PREVIEW_LINES),
  };
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines)
 * and optional `headPreview` (first ≤M non-empty lines) that `formatOutcome`
 * uses to render actual content in the scrollback outcome row.
 *
 * When head and tail together cover all available non-empty lines, all lines
 * are returned in `tailPreview` with no duplication and `hiddenLineCount` is
 * set to 0.  When they overlap (head + tail ≥ nonEmpty.length but non-empty
 * set is small), the merged set is deduped automatically.
 *
 * `headPreview` is only present when headLines > 0 and there are enough lines
 * to warrant a separate head slice (otherwise the tail slice already covers
 * everything).
 */
export function truncateContent(
  content: string,
  config?: { tailLines?: number; headLines?: number },
): { content: string; truncated: boolean; lineCount?: number; sizeBytes: number; sizeLabel: string; tailPreview?: string[]; headPreview?: string[]; hiddenLineCount?: number } {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sizeLabel = formatByteSize(sizeBytes);

  const tailLines = config?.tailLines ?? DEFAULT_TAIL_PREVIEW_LINES;
  const headLines = config?.headLines ?? DEFAULT_HEAD_PREVIEW_LINES;

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

  // Determine effective slices, handling overlap.
  // When headLines + tailLines >= nonEmpty.length, show all lines (no hidden).
  const effectiveTail = Math.max(0, tailLines);
  const effectiveHead = Math.max(0, headLines);

  let tailPreview: string[];
  let headPreview: string[] | undefined;
  let hiddenLineCount: number;

  if (effectiveHead > 0 && effectiveTail > 0) {
    // Both head and tail requested.
    if (effectiveHead + effectiveTail >= nonEmptyLines.length) {
      // They cover everything — show all, no hidden indicator.
      tailPreview = nonEmptyLines;
      headPreview = undefined; // caller sees everything in tailPreview
      hiddenLineCount = 0;
    } else {
      // Non-overlapping slices; compute actual hidden count from raw line count.
      const headSlice = nonEmptyLines.slice(0, effectiveHead);
      const tailSlice = nonEmptyLines.slice(-effectiveTail);
      headPreview = headSlice;
      tailPreview = tailSlice;
      // hiddenLineCount: raw lines minus the visible tail lines (same denominator
      // as lineCount = lines.length, matching the original contract so the UI
      // reads "N lines, M earlier lines hidden" where M is computed from raw lines).
      hiddenLineCount = lines.length - tailPreview.length;
    }
  } else if (effectiveTail > 0) {
    // Tail only (original behaviour).
    tailPreview = nonEmptyLines.slice(-effectiveTail);
    headPreview = undefined;
    // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
    // so the UI reads coherently: "N lines, M earlier lines hidden" implies
    // N - M lines are visible in the tail preview.
    hiddenLineCount = lines.length - tailPreview.length;
  } else {
    // effectiveTail === 0 — tail disabled; show head only (or nothing if head is 0 too).
    if (effectiveHead > 0) {
      tailPreview = nonEmptyLines.slice(0, effectiveHead);
      headPreview = undefined; // single slice, returned in tailPreview for compat
    } else {
      tailPreview = [];
    }
    hiddenLineCount = lines.length - tailPreview.length;
  }

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return {
      content,
      truncated: false,
      lineCount: lines.length,
      sizeBytes,
      sizeLabel,
      tailPreview: tailPreview.length > 0 ? tailPreview : undefined,
      ...(headPreview !== undefined && { headPreview }),
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
    tailPreview: tailPreview.length > 0 ? tailPreview : undefined,
    ...(headPreview !== undefined && { headPreview }),
    hiddenLineCount,
  };
}
