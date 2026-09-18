/**
 * Display-only pre-processor: auto-closes unclosed inline markdown markers so
 * the marked lexer never sees a dangling span while a chunk is still streaming.
 *
 * Callers must NOT write the return value back to the pending buffer — this is
 * purely for rendering and does not affect parser state.
 */

// Invariant: markers are checked longest-first so `**` is consumed before a
// lone `*` could miscount its two characters as two italic markers.
const MARKERS = ['**', '~~', '*', '`'] as const;

/** Count non-overlapping occurrences of `marker` in `text`. */
function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(marker, pos)) !== -1) {
    count++;
    pos += marker.length;
  }
  return count;
}

/**
 * Append closing markers for any unclosed inline markdown spans in `text`.
 *
 * - Pure function: the input string is never modified.
 * - Display-only: callers must not persist the return value back to the buffer.
 * - Checks `**` before `*` so bold markers are not double-counted as italics.
 * - Counts non-overlapping occurrences; odd count → unclosed → appends closer.
 * - Multiple unclosed markers are all closed in fixed MARKERS-array order
 *   (`**`, `~~`, `*`, `` ` ``). This is a display-only approximation: nesting
 *   order is not tracked, so closers are appended outermost-first by array
 *   position rather than true innermost-first. Acceptable for streaming preview.
 */
export function closePendingInlineSyntax(text: string): string {
  if (!text) return text;

  let result = text;
  let cleaned = text; // progressively stripped of consumed longer markers

  for (const marker of MARKERS) {
    const count = countOccurrences(cleaned, marker);
    if (count % 2 !== 0) {
      result += marker;
    }
    // Remove this marker's occurrences from cleaned so shorter markers
    // that share characters (e.g., * inside **) are not double-counted.
    cleaned = cleaned.replaceAll(marker, '\0'.repeat(marker.length));
  }

  return result;
}
