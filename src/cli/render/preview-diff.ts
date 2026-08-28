/**
 * PreviewDiff — pre-execution diff preview render component.
 *
 * A pure `(payload, opts?) => string` component that renders a diff preview
 * for display in the live overlay before an `edit_file` write occurs. The
 * `⟳ Proposed` label distinguishes it from the post-execution diff that
 * arrives via the `tool_diff` sidecar channel.
 *
 * Delegates all diff layout to {@link compactDiffView} so truncation,
 * box-framing, and line-colouring are handled identically.
 *
 * LOC ceiling: 350 (enforced by audit:filesize:check).
 */

import { palette } from '../palette.js';
import { compactDiffView } from './compact-diff-view.js';
import type { DiffPayload } from '../../utils/diff.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PreviewDiffOptions {
  /**
   * Optional file path shown in the stat header of the compact diff view.
   * When omitted a generic `'preview'` placeholder is used — the tool-lane
   * entry's own prefix line already names the file, so this is supplemental.
   */
  filePath?: string;
  /**
   * Maximum number of diff body lines to render before truncating.
   * Passed through to {@link compactDiffView}. Default: 20.
   */
  maxLines?: number;
  /**
   * Terminal width passed through to {@link compactDiffView} for box sizing.
   * Default: 80.
   */
  width?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a pre-execution diff preview as a multi-line string for overlay display.
 *
 * @param payload - Structured diff produced by {@link computeLineDiff}.
 * @param opts    - Optional rendering overrides (filePath, maxLines, width).
 * @returns A styled, multi-line string beginning with `⟳ Proposed`.
 *          Ends without a trailing newline.
 */
export function previewDiff(payload: DiffPayload, opts: PreviewDiffOptions = {}): string {
  const spec = {
    filePath: opts.filePath ?? 'preview',
    hunks: payload.hunks.map((h) => ({
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: h.lines.map((l) => `${l.kind === ' ' ? ' ' : l.kind} ${l.text}`),
    })),
    stats: { added: payload.addedLines, removed: payload.removedLines },
    ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
    ...(opts.width !== undefined ? { width: opts.width } : {}),
  };
  return palette.dim('⟳ Proposed') + '\n' + compactDiffView(spec);
}
