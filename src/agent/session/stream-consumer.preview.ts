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
 * Default number of tail lines in the bash output preview.
 * Overridable via AFK_BASH_PREVIEW_TAIL_LINES or bash.previewTailLines config.
 */
export const DEFAULT_TAIL_PREVIEW_LINES = 7;

/** Maximum accepted value for head/tail line counts (matches config clamp). */
export const MAX_PREVIEW_LINES = 50;

/**
 * Parse a raw string value into a valid preview line count.
 * Returns the default when the value is absent, non-numeric, negative,
 * non-integer, or exceeds MAX_PREVIEW_LINES.
 */
function parsePreviewLineCount(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  // Digit-anchored (same convention as concurrency.ts) — reject floats, hex, etc.
  if (!/^\d+$/.test(trimmed)) return defaultValue;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PREVIEW_LINES) return defaultValue;
  return n;
}

/**
 * Resolve the effective tail preview line count.
 *
 * Precedence (highest → lowest):
 *   1. afk.config.json `bash.previewTailLines` (passed in as `configValue`)
 *   2. `AFK_BASH_PREVIEW_TAIL_LINES` env var
 *   3. Hard-coded default (7)
 *
 * The caller is responsible for reading the config value and passing it in.
 * This keeps the pure preview logic free of config-loading I/O so it remains
 * trivially testable.
 */
export function resolveTailLines(configValue?: number): number {
  if (configValue !== undefined && Number.isInteger(configValue) && configValue >= 0 && configValue <= MAX_PREVIEW_LINES) {
    return configValue;
  }
  return parsePreviewLineCount(env.AFK_BASH_PREVIEW_TAIL_LINES, DEFAULT_TAIL_PREVIEW_LINES);
}

/**
 * Resolve the effective head preview line count.
 *
 * Precedence (highest → lowest):
 *   1. afk.config.json `bash.previewHeadLines` (passed in as `configValue`)
 *   2. `AFK_BASH_PREVIEW_HEAD_LINES` env var
 *   3. Hard-coded default (0 — head disabled by default)
 */
export function resolveHeadLines(configValue?: number): number {
  if (configValue !== undefined && Number.isInteger(configValue) && configValue >= 0 && configValue <= MAX_PREVIEW_LINES) {
    return configValue;
  }
  return parsePreviewLineCount(env.AFK_BASH_PREVIEW_HEAD_LINES, 0);
}

/**
 * Clip the raw tool output to an 80-char single-line preview for the live
 * tool-lane overlay. Also extracts a `tailPreview` (last ≤N non-empty lines)
 * and optional `headPreview` (first ≤M non-empty lines) that `formatOutcome`
 * uses to render an actual preview in the scrollback outcome row.
 *
 * The number of tail and head lines is resolved at call time via
 * `resolveTailLines` / `resolveHeadLines` (env var → hard-coded default).
 * Pass `tailLines` / `headLines` to override for tests or config-driven callers.
 *
 * Overlap handling: when head + tail >= total non-empty lines, all lines are
 * returned as tailPreview (no headPreview) so duplicates never appear.
 * hiddenLineCount is then 0.
 */
export function truncateContent(
  content: string,
  tailLines?: number,
  headLines?: number,
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

  // Resolve effective line counts (env / default if not provided).
  const effectiveTail = tailLines !== undefined ? tailLines : resolveTailLines();
  const effectiveHead = headLines !== undefined ? headLines : resolveHeadLines();

  // Multi-line path: always extract lineCount and preview arrays so the TUI can
  // render the actual preview lines regardless of total character count.
  const nonEmptyLines = lines.filter(l => l.trim() !== '');

  let resolvedHead: string[];
  let resolvedTail: string[];
  let hiddenLineCount: number;

  if (effectiveHead + effectiveTail >= nonEmptyLines.length) {
    // Overlap or exact coverage: show all lines as tail (no head, no hidden).
    resolvedHead = [];
    resolvedTail = effectiveTail > 0 ? nonEmptyLines.slice(-Math.min(effectiveTail, nonEmptyLines.length)) : nonEmptyLines;
    if (effectiveHead > 0 && effectiveTail === 0) {
      // head-only mode with overlap: use headPreview path
      resolvedTail = [];
    }
    hiddenLineCount = 0;
  } else {
    resolvedTail = effectiveTail > 0 ? nonEmptyLines.slice(-effectiveTail) : [];
    resolvedHead = effectiveHead > 0 ? nonEmptyLines.slice(0, effectiveHead) : [];
    // Contract: hiddenLineCount uses lines.length (same denominator as lineCount)
    // so the UI reads coherently: "N lines, M earlier lines hidden" implies
    // N - M lines are visible in the tail preview.
    const visibleTail = resolvedTail.length;
    const visibleHead = resolvedHead.length;
    hiddenLineCount = lines.length - visibleTail - visibleHead;
    if (hiddenLineCount < 0) hiddenLineCount = 0;
  }

  // Build return value. headPreview is omitted when empty to keep the shape
  // backward-compatible (callers that only use tailPreview are unaffected).
  function buildResult(truncated: boolean, displayContent: string) {
    const result: ReturnType<typeof truncateContent> = {
      content: displayContent,
      truncated,
      lineCount: lines.length,
      sizeBytes,
      sizeLabel,
      hiddenLineCount,
    };
    if (resolvedTail.length > 0) result.tailPreview = resolvedTail;
    if (resolvedHead.length > 0) result.headPreview = resolvedHead;
    return result;
  }

  if (content.length <= 80) {
    // Content fits the preview budget — show it verbatim.
    return buildResult(false, content);
  }

  // Content exceeds the 80-char display budget — collapse to "first line …+N lines".
  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return buildResult(true, truncatedContent);
}
