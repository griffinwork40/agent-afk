/**
 * Live-preview helpers for streaming code fences and tables.
 *
 * These helpers are split into a sibling file to keep
 * `markdown-stream-format.ts` under the 350-line ceiling.
 *
 * Both helpers render a dimmed, partially-complete view of content that is
 * still accumulating in the pending buffer — matching the UX goal of "show
 * real content instead of a placeholder" while clearly signalling that the
 * block has not yet committed.
 *
 * Rules shared by both helpers:
 *  - Use `palette.dim()` for all output — never raw `chalk.dim()`.
 *  - Use `calculateContentWidth()` (code measure) for wrapping — NOT the prose
 *    measure — so code lines are not artificially narrow.
 *  - Do NOT apply `closePendingInlineSyntax()` — that is prose-only.
 *  - Do NOT apply syntax highlighting — deferred to commit time.
 *  - The caller (`formatPendingBuffer`) still wraps the returned string with
 *    `wrapToWidth(…, { breakLongWords: true })` as its last step, so the
 *    preview lines themselves should NOT be hard-wrapped here; soft wrap is
 *    sufficient and allows the outer gate to set the column limit uniformly.
 */

import { palette } from './palette.js';

// ---------------------------------------------------------------------------
// 2A: Live code fence preview
// ---------------------------------------------------------------------------

/**
 * Extract the language tag (if any) from a fence opener line such as
 * "```python" or "~~~TypeScript". Returns an empty string when no tag is
 * present (bare "```" or "~~~").
 */
function extractFenceLanguage(openerLine: string): string {
  const m = openerLine.match(/^ {0,3}(?:```|~~~)(.*)$/);
  if (!m || m[1] === undefined) return '';
  return m[1].trim();
}

/**
 * Render a live preview of an open code fence.
 *
 * Locates the LAST fence-opener line in `buffer` (the one that opened the
 * still-unclosed fence), extracts everything after it as the code body, and
 * renders it dimmed. If a language tag was specified a dim language label is
 * prepended.
 *
 * @param buffer      - The full pending buffer, known to be in an open fence.
 * @param contentWidth - Width for wrapping (code measure, not prose measure).
 */
export function previewCodeFence(buffer: string, _contentWidth: number): string {
  const lines = buffer.split('\n');

  // Find the last fence opener (the one that is currently unclosed).
  // We scan from the end so that if two fences appear — one closed, one open —
  // we target the inner unclosed one.
  let openerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i] ?? '';
    if (/^ {0,3}(?:```|~~~)[^\n]*$/.test(candidate)) {
      openerIdx = i;
      break;
    }
  }

  // Should never happen when called correctly (buffer is in an open fence),
  // but fall back gracefully.
  if (openerIdx === -1) {
    return palette.dim('\n▍ streaming code…\n');
  }

  const openerLine = lines[openerIdx] ?? '';
  const lang = extractFenceLanguage(openerLine);
  // Everything after the opener (may be empty if only the opening line arrived)
  const codeLines = lines.slice(openerIdx + 1);
  const codeBody = codeLines.join('\n');

  const parts: string[] = [];

  if (lang) {
    parts.push(palette.dim(`[${lang}]`));
  }

  if (codeBody.trim()) {
    parts.push(palette.dim(codeBody));
  }

  if (parts.length === 0) return palette.dim('\n\u258d streaming code\u2026\n');

  // Always end with a trailing newline so the overlay doesn't abut the cursor.
  const content = parts.join('\n');
  return '\n' + content + '\n';
}

// ---------------------------------------------------------------------------
// 2B: Live table preview
// ---------------------------------------------------------------------------

/**
 * Render a live preview of an open (still-accumulating) GFM table.
 *
 * Extracts lines that look like table rows (contain `|`) and renders them as
 * dimmed, pipe-delimited text — no column alignment, which happens at commit
 * time via the full table renderer.
 *
 * @param buffer      - The full pending buffer, known to contain an open table.
 * @param contentWidth - Width for wrapping (code measure).
 */
export function previewTable(buffer: string, _contentWidth: number): string {
  const tableLines = buffer
    .split('\n')
    .filter((line) => line.includes('|'));

  if (tableLines.length === 0) {
    return palette.dim('\n▍ streaming table…\n');
  }

  const tableText = tableLines.join('\n');
  return '\n' + palette.dim(tableText) + '\n';
}
