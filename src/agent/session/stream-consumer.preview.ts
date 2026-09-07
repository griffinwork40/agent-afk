/** Display-only output sizing and tail/head extraction. */
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

/** Default number of tail lines shown in the bash output preview. */
const DEFAULT_TAIL_LINES = 7;
/** Default number of head lines shown in the bash output preview (disabled). */
const DEFAULT_HEAD_LINES = 0;

/**
 * Parse a non-negative integer from an env var string. Returns `undefined`
 * when the raw value is absent, non-integer, negative, or NaN. The `minValue`
 * parameter further rejects values strictly below it (e.g. 1 rejects 0).
 */
function parsePositiveEnvInt(raw: string | undefined, minValue = 0): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < minValue) return undefined;
  return n;
}

/**
 * Resolve the current preview configuration from env vars, falling back to
 * hard defaults. Reads env vars at call time so tests can set them mid-run.
 */
function resolvePreviewConfig(): { tailLines: number; headLines: number } {
  const tailLines =
    parsePositiveEnvInt(env.AFK_BASH_PREVIEW_TAIL_LINES, 1) ?? DEFAULT_TAIL_LINES;
  const headLines =
    parsePositiveEnvInt(env.AFK_BASH_PREVIEW_HEAD_LINES, 0) ?? DEFAULT_HEAD_LINES;
  return { tailLines, headLines };
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines)
 * and optional `headPreview` (first ≤M non-empty lines) that `formatOutcome`
 * uses to render actual head/tail lines in the scrollback outcome row.
 *
 * Overlap dedup: when head + tail would cover all non-empty lines, only
 * `tailPreview` is emitted (no `headPreview`) to avoid duplicate display.
 * The `hiddenLineCount` is always computed from the actual displayed selection.
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
  const { tailLines, headLines } = resolvePreviewConfig();
  const nonEmptyLines = lines.filter(l => l.trim() !== '');
  const tailPreview = nonEmptyLines.slice(-tailLines);

  // Head preview: only emit when headLines > 0 and there is no overlap with
  // the tail. Overlap occurs when head + tail would cover all non-empty lines
  // — in that case show everything via tailPreview alone (which slices from
  // the end and effectively includes the whole array when length ≤ tailLines).
  let headPreview: string[] | undefined;
  if (headLines > 0 && nonEmptyLines.length > tailLines + headLines) {
    headPreview = nonEmptyLines.slice(0, headLines);
  }

  // hiddenLineCount: lines.length is the denominator (same as lineCount) so
  // the UI reads "N lines, M earlier lines hidden" coherently. The number of
  // displayed non-empty lines equals tailPreview.length (+ headPreview.length
  // when present), but we subtract from the raw line count so the contract
  // stays consistent with the pre-existing meaning of hiddenLineCount.
  const displayedLines = tailPreview.length + (headPreview?.length ?? 0);
  const hiddenLineCount = lines.length - displayedLines;

  if (content.length <= 80) {
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
