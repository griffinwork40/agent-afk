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

/**
 * Read the configured tail-line count from AFK_BASH_TAIL_LINES at call time.
 * Default 7, clamped to [0, 50]. Non-integer or out-of-range values fall back
 * to the default. Reads from the env registry, never direct process.env.
 */
function tailPreviewLines(): number {
  const DEFAULT = 7;
  const MAX = 50;
  const raw = env.AFK_BASH_TAIL_LINES;
  if (raw === undefined) return DEFAULT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX) return DEFAULT;
  return n;
}

/**
 * Read the configured head-line count from AFK_BASH_HEAD_LINES at call time.
 * Default 0 (disabled), clamped to [0, 50]. Non-integer or out-of-range values
 * fall back to 0. Reads from the env registry, never direct process.env.
 */
function headPreviewLines(): number {
  const DEFAULT = 0;
  const MAX = 50;
  const raw = env.AFK_BASH_HEAD_LINES;
  if (raw === undefined) return DEFAULT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX) return DEFAULT;
  return n;
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines,
 * where N is AFK_BASH_TAIL_LINES, default 7) and optionally a `headPreview`
 * (first ≤M non-empty lines, where M is AFK_BASH_HEAD_LINES, default 0/disabled)
 * that `formatOutcome` uses to render an actual head+tail in the scrollback
 * outcome row instead of only a line count. When head + tail ≥ total non-empty
 * lines, all lines are shown without duplication.
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

  // Multi-line path: always extract lineCount and tailPreview so the TUI can
  // render the actual tail lines regardless of total character count.
  // Short multi-line output (≤80 chars) is shown verbatim as the preview
  // (no display truncation needed), but we still expose lineCount+tailPreview
  // so the outcome row renders the tail preview block rather than hiding it.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  const tailCount = tailPreviewLines();
  const headCount = headPreviewLines();

  let headPreview: string[] | undefined;
  let tailPreview: string[];

  if (headCount > 0 && headCount + tailCount >= nonEmptyLines.length) {
    // Overlap: head + tail covers all lines — show everything, no duplication.
    tailPreview = nonEmptyLines;
    headPreview = undefined; // sentinel: all lines shown via tailPreview
  } else if (headCount > 0) {
    // Both head and tail requested, no overlap.
    headPreview = nonEmptyLines.slice(0, headCount);
    tailPreview = nonEmptyLines.slice(-tailCount);
  } else {
    // Default path: tail only (headCount === 0).
    headPreview = undefined;
    tailPreview = tailCount > 0 ? nonEmptyLines.slice(-tailCount) : [];
  }

  // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
  // so the UI reads coherently: "N lines, M earlier lines hidden" implies
  // N - M lines are visible in the displayed selection.
  const displayedCount = (headPreview?.length ?? 0) + tailPreview.length;
  const hiddenLineCount = lines.length - displayedCount;

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim. lineCount and
    // tailPreview are still set so formatOutcome renders the tail block.
    return { content, truncated: false, lineCount: lines.length, sizeBytes, sizeLabel, headPreview, tailPreview, hiddenLineCount };
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, lineCount: lines.length, sizeBytes, sizeLabel, headPreview, tailPreview, hiddenLineCount };
}
