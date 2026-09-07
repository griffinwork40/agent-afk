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

/** Defaults and valid range for preview line counts. */
const PREVIEW_TAIL_DEFAULT = 7;
const PREVIEW_HEAD_DEFAULT = 0;
const PREVIEW_MIN = 0; // head may be 0 (disabled)
const PREVIEW_TAIL_MIN = 1; // tail must show at least 1 line
const PREVIEW_MAX = 50;

/**
 * Parse and clamp a raw env-var string to a valid preview line count.
 * Returns `fallback` when the raw value is absent, non-numeric, or NaN.
 * The `min` and `max` arguments bound the result after parsing.
 */
function parsePreviewCount(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Read preview size configuration from env vars (lazy, test-friendly — reads
 * process.env on every call via the `env` proxy, so test mutations are
 * reflected immediately without module reloading).
 */
export function getPreviewConfig(): { tailLines: number; headLines: number } {
  const tailLines = parsePreviewCount(
    env.AFK_BASH_PREVIEW_TAIL_LINES,
    PREVIEW_TAIL_DEFAULT,
    PREVIEW_TAIL_MIN,
    PREVIEW_MAX,
  );
  const headLines = parsePreviewCount(
    env.AFK_BASH_PREVIEW_HEAD_LINES,
    PREVIEW_HEAD_DEFAULT,
    PREVIEW_MIN,
    PREVIEW_MAX,
  );
  return { tailLines, headLines };
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * where N comes from `getPreviewConfig()`) and an optional `headPreview`
 * (first ≤M non-empty lines) that `formatOutcome` uses to render an actual
 * head+tail in the scrollback outcome row instead of only a line count.
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
  const { tailLines, headLines } = getPreviewConfig();
  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  let tailPreview: string[];
  let headPreview: string[] | undefined;
  let hiddenLineCount: number;

  if (headLines > 0 && headLines + tailLines >= nonEmptyLines.length) {
    // Head + tail covers the full output — show everything without duplication.
    tailPreview = nonEmptyLines;
    headPreview = undefined; // collapsed: one contiguous block, no hidden gap
    hiddenLineCount = 0;
  } else if (headLines > 0) {
    // Separate head and tail blocks with a hidden gap between them.
    headPreview = nonEmptyLines.slice(0, headLines);
    tailPreview = nonEmptyLines.slice(-tailLines);
    // hiddenLineCount uses lines.length (same denominator as lineCount) so the
    // UI reads: "N lines, M earlier lines hidden" → N - M visible in tail+head.
    const displayedCount = headPreview.length + tailPreview.length;
    hiddenLineCount = Math.max(0, lines.length - displayedCount);
  } else {
    // Default: tail only, no head.
    tailPreview = nonEmptyLines.slice(-tailLines);
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
      tailPreview,
      headPreview,
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
    tailPreview,
    headPreview,
    hiddenLineCount,
  };
}
