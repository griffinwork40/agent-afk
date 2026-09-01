/**
 * FileOpSummary — compact aggregate file-operation summary line.
 *
 * Renders a single collapsed summary of file operations that completed in
 * a turn, mirroring Claude Code's "Analyzed N files, edited M files" style.
 * Used as a compact substitute for per-call tool cards when multiple file
 * operations complete together and vertical space is at a premium.
 *
 * Design:
 *   - Pure function (spec → string), no I/O, no side effects.
 *   - Palette-only coloring (never raw chalk).
 *   - Width-aware: truncates gracefully at narrow terminal budgets.
 *   - Returns `''` when the spec is empty (all counts zero/absent) so callers
 *     can safely drop the output without a visibility check.
 */

import { palette } from '../palette.js';
import { displayWidth, truncateDisplayWidth } from '../display.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Input spec for {@link fileOpSummary}.
 *
 * All count fields are optional; absent or `0` values are silently omitted
 * from the rendered line. A spec with all counts absent/zero returns `''`.
 */
export interface FileOpSummarySpec {
  /**
   * Number of files read (via `read_file`, `list_directory`, `glob`, `grep`).
   * Omitted or `0` → read segment skipped.
   */
  filesRead?: number;
  /**
   * Number of files written (via `write_file`).
   * Omitted or `0` → write segment skipped.
   */
  filesWritten?: number;
  /**
   * Number of files edited (via `edit_file`).
   * Omitted or `0` → edit segment skipped.
   */
  filesEdited?: number;
  /**
   * Number of files deleted (via destructive shell ops or explicit deletes).
   * Omitted or `0` → delete segment skipped.
   */
  filesDeleted?: number;
  /**
   * Terminal column width used for truncation.
   * Defaults to 80. The component never reads `process.stdout.columns` so it
   * stays a pure spec → string transform.
   */
  width?: number;
}

// ─── Segment builders ────────────────────────────────────────────────────────

/**
 * Format a count + noun segment, pluralizing the noun when count > 1.
 *
 * Invariant: callers guard count > 0 before calling so count is always ≥ 1.
 */
function segment(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a compact single-line aggregate file-operation summary.
 *
 * Visual output examples:
 *   analyzed 4 files, edited 2 files, created 1 file
 *   analyzed 12 files
 *   edited 3 files, created 1 file, deleted 1 file
 *
 * The output is dim-styled (low visual weight) so it recedes relative to the
 * assistant's prose and the result is self-describing without dominating the
 * scrollback region.
 *
 * Returns `''` when the spec is empty so callers can omit the line cleanly:
 * ```ts
 * const summary = fileOpSummary({ filesRead: 0 });
 * // summary === '' — nothing to write
 * ```
 *
 * Pure function — no side effects.
 *
 * @param spec - File operation counts and rendering options.
 * @returns Single-line ANSI string, or `''` when all counts are absent/zero.
 */
export function fileOpSummary(spec: FileOpSummarySpec): string {
  const width = Math.max(1, spec.width ?? 80);

  const read    = spec.filesRead    ?? 0;
  const written = spec.filesWritten ?? 0;
  const edited  = spec.filesEdited  ?? 0;
  const deleted = spec.filesDeleted ?? 0;

  // Early exit when nothing to summarize.
  if (read === 0 && edited === 0 && written === 0 && deleted === 0) return '';

  // Build the full label with operation verbs.
  // "analyzed N files" for reads; plain counts for mutations so the line
  // reads naturally ("3 edits, 2 files created" not "created 2 files").
  const label = buildLabel(read, edited, written, deleted);

  return palette.dim(truncateDisplayWidth(label, Math.max(1, width - displayWidth('  '))));
}

// ─── Label builder ────────────────────────────────────────────────────────────

/**
 * Compose the natural-language summary from the operation counts.
 *
 * Reads use an "analyzed" verb prefix to match Claude Code phrasing;
 * mutations use plain noun phrases joined by commas.
 *
 * Contract: at least one count > 0; the return is always a non-empty string.
 */
function buildLabel(
  read: number,
  edited: number,
  written: number,
  deleted: number,
): string {
  // When only reads occurred, use the "analyzed" verb form ("analyzed 4 files").
  // When mutations are present, use a flat join ("3 edits, 2 files created").
  // When both reads and mutations are present, prefix the read count with
  // "analyzed" and append the mutations: "analyzed 4 files, 2 edits".
  const hasMutation = edited > 0 || written > 0 || deleted > 0;

  if (!hasMutation) {
    // Pure-read case: "analyzed N file(s)"
    return `analyzed ${segment(read, 'file', 'files')}`;
  }

  // Mutation case: rebuild with verb prefix on the read segment.
  const segments: string[] = [];

  if (read    > 0) segments.push(`analyzed ${segment(read, 'file', 'files')}`);
  if (edited  > 0) segments.push(segment(edited,  'edit',          'edits'));
  if (written > 0) segments.push(segment(written, 'file created',  'files created'));
  if (deleted > 0) segments.push(segment(deleted, 'file deleted',  'files deleted'));

  return segments.join(', ');
}
