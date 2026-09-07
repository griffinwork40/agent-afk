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

/** Default number of tail lines to capture for the TUI outcome preview. */
const DEFAULT_TAIL_LINES = 7;
/** Default number of head lines to capture (0 = disabled). */
const DEFAULT_HEAD_LINES = 0;
/** Maximum clamped value for head/tail line counts. */
export const PREVIEW_LINES_MAX = 50;

/**
 * Options for {@link truncateContent}.
 * Keep these separate from model-context output caps and capture retention
 * limits — they control only TUI display preference.
 */
export interface TruncateContentOpts {
  /** Number of tail (bottom) lines to include in the preview. Default 7. Clamped to [0, 50]. */
  tailLines?: number;
  /** Number of head (top) lines to include in the preview. Default 0 (disabled). Clamped to [0, 50]. */
  headLines?: number;
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤tailLines non-empty
 * lines) and optional `headPreview` (first headLines non-empty lines) that
 * `formatOutcome` uses to render an actual preview in the scrollback outcome
 * row instead of only a line count.
 *
 * Configuration precedence (highest wins):
 *   `opts` parameter > `AFK_BASH_PREVIEW_TAIL_LINES` / `AFK_BASH_PREVIEW_HEAD_LINES` env
 *   > `bashPreview` in afk.config.json > built-in defaults (7 tail, 0 head).
 *
 * Overlap: when headLines + tailLines ≥ the number of non-empty lines, all
 * lines are shown verbatim (headPreview is cleared, tailPreview holds all
 * lines, hiddenLineCount is 0).
 */
export function truncateContent(
  content: string,
  opts?: TruncateContentOpts,
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

  // Clamp to [0, PREVIEW_LINES_MAX]; NaN/undefined → defaults.
  const tailLines = clampPreviewLines(opts?.tailLines, DEFAULT_TAIL_LINES);
  const headLines = clampPreviewLines(opts?.headLines, DEFAULT_HEAD_LINES);

  const lines = content.split('\n');

  // Single-line path: no lineCount / tail/headPreview needed.
  if (lines.length <= 1) {
    if (content.length <= 80) {
      return { content, truncated: false, sizeBytes, sizeLabel };
    }
    const truncated = content.substring(0, 80) + '…';
    return { content: truncated, truncated: true, sizeBytes, sizeLabel };
  }

  // Multi-line path: always extract lineCount and tail/headPreview so the TUI
  // can render the actual preview lines regardless of total character count.
  // Short multi-line output (≤80 chars) is shown verbatim as the preview
  // (no display truncation needed), but we still expose lineCount+tailPreview
  // so the outcome row renders the tail preview block rather than hiding it.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  let tailPreview: string[] | undefined;
  let headPreview: string[] | undefined;
  let hiddenLineCount: number;

  if (headLines + tailLines >= nonEmptyLines.length) {
    // Overlap: show all lines; suppress the "earlier lines hidden" label.
    tailPreview = nonEmptyLines;
    headPreview = undefined;
    hiddenLineCount = 0;
  } else {
    tailPreview = tailLines > 0 ? nonEmptyLines.slice(-tailLines) : undefined;
    headPreview = headLines > 0 ? nonEmptyLines.slice(0, headLines) : undefined;
    // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
    // so the UI reads coherently: "N lines, M earlier lines hidden" implies
    // N - M lines are visible in the preview.
    hiddenLineCount = lines.length
      - (headPreview?.length ?? 0)
      - (tailPreview?.length ?? 0);
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
      ...(tailPreview !== undefined && tailPreview.length > 0 && { tailPreview }),
      ...(headPreview !== undefined && headPreview.length > 0 && { headPreview }),
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
    ...(tailPreview !== undefined && tailPreview.length > 0 && { tailPreview }),
    ...(headPreview !== undefined && headPreview.length > 0 && { headPreview }),
    hiddenLineCount,
  };
}

/**
 * Clamp a raw preview-line count to [0, PREVIEW_LINES_MAX].
 * Non-integer, NaN, and negative values fall back to `defaultVal`.
 */
function clampPreviewLines(raw: number | undefined, defaultVal: number): number {
  if (raw === undefined || !Number.isInteger(raw) || raw < 0) return defaultVal;
  return Math.min(raw, PREVIEW_LINES_MAX);
}
