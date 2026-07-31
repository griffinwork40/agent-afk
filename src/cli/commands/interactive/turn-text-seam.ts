/**
 * Round-boundary seam for accumulated assistant text.
 *
 * @module cli/commands/interactive/turn-text-seam
 */

/**
 * Contract: join `next` (the first text of a NEW tool-use round) onto
 * `accumulated` (every prior round's text) across a ROUND SEAM, inserting the
 * paragraph break the seam itself carries no character for.
 *
 * Why a separator is needed at all: within one round, assistant text arrives as
 * mid-sentence `delta.text` chunks that MUST concatenate verbatim ('' join) —
 * inserting anything there would corrupt words. But a tool-use round boundary
 * is a different seam: the text before a tool call and the text after it are
 * two distinct assistant text blocks, and the API transmits their separation
 * structurally (separate content blocks) rather than as whitespace in either
 * block's payload. Appending with '' therefore fused them, which is how
 * persisted transcripts ended up with "…(build doesn't type/lint check).All
 * lint errors are pre-existing" and "…the affected test suites.Diff is clean" —
 * the reported "missing space" artifacts. Restoring '\n\n' here reproduces the
 * paragraph break the model expressed as a block boundary.
 *
 * Idempotent at the seam: when either side already carries whitespace across it
 * (a round whose text ends with a newline, or a next block whose first delta
 * opens with one), the existing whitespace is authoritative and nothing is
 * added — so a repeated or already-separated seam never accumulates blank
 * lines. An empty accumulator returns `next` unchanged, so the first round of a
 * turn is never prefixed.
 */
export function joinAtRoundSeam(accumulated: string, next: string): string {
  if (accumulated.length === 0 || next.length === 0) return accumulated + next;
  if (/\s$/.test(accumulated) || /^\s/.test(next)) return accumulated + next;
  return accumulated + '\n\n' + next;
}
