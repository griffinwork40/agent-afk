import { palette } from '../palette.js';

// ─── File Op Summary ─────────────────────────────────────────────────────────

/**
 * Render a single-line aggregate summary of file operations in a turn.
 *
 * Mirrors the compact summary Claude Code surfaces after tool-heavy turns,
 * e.g. "Analyzed 5 files, edited 3 files, wrote 1 file".
 *
 * Visual output:
 *   ◆ Analyzed 5 files  ·  Edited 3 files  ·  Wrote 1 file
 *
 * Zero-count segments are omitted. If all counts are zero, returns an
 * empty string. Handles singular/plural automatically.
 *
 * @param spec - File operation counts.
 * @returns Single-line ANSI string, or empty string when all counts are zero.
 */
export function fileOpSummary(spec: FileOpSummarySpec): string {
  const parts: string[] = [];

  if (spec.filesRead > 0) {
    parts.push(`Analyzed ${palette.bold(String(spec.filesRead))} ${plural(spec.filesRead, 'file')}`);
  }
  if (spec.filesEdited > 0) {
    parts.push(`Edited ${palette.bold(String(spec.filesEdited))} ${plural(spec.filesEdited, 'file')}`);
  }
  if (spec.filesWritten > 0) {
    parts.push(`Wrote ${palette.bold(String(spec.filesWritten))} ${plural(spec.filesWritten, 'file')}`);
  }

  if (parts.length === 0) return '';

  const icon = palette.info('◆');
  const body = parts.join(palette.dim('  ·  '));
  return `${icon}  ${body}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Input spec for {@link fileOpSummary}. */
export interface FileOpSummarySpec {
  /** Number of files read / analyzed. */
  filesRead: number;
  /** Number of files written (new files created). */
  filesWritten: number;
  /** Number of files edited (existing files modified). */
  filesEdited: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return `word` with an `s` appended when `count !== 1`. */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
