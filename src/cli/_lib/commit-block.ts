/**
 * commitBlockAbove — commit a coherent multi-line block to scrollback as a
 * SINGLE `commitAbove` call.
 *
 * @module cli/_lib/commit-block
 */

/** Minimal structural slice of TerminalCompositor this helper needs. */
export interface BlockCommitter {
  commitAbove(text: string): void;
}

// Invariant (one geometry per commit): TerminalCompositor.commitAbove places a
// whole block with ONE geometry decision — a single pre-clear `prevTopRow`
// capture and a single fits / band-hold / overflow route (see
// terminal-compositor.committed-band-commit.ts, "one geometry per commit", and
// terminal-compositor.commit-mode.ts). Committing a block one line at a time
// forces N independent geometry decisions: under a TALL overlay the per-line
// band-hold/fits routing desyncs the committed-band model from the screen and
// scrolls unpainted (blank) rows into scrollback — the "weird gaps" (and, in
// the worst geometry, dropped-line) rendering bug. Joining the block into one
// call restores the atomic contract: commitAbove re-splits on '\n' and
// hard-wraps each row, so a row wider than the terminal still maps to exactly
// one logical line, and the band-hold row math stays exact.
//
// `lines` are the physical rows of ONE rendered artifact (a card, a flushed
// tool-lane block, an input echo) — NOT independent scrollback entries — so
// committing them as a single block is always the correct semantics.
//
// Empty input is a no-op, matching the prior `for (const line of lines)` loops
// (each was length-guarded, or iterated an always-non-empty card split).
//
// TTY-only: the band-hold desync this prevents is a property of the live
// compositor frame. Non-TTY callers write each line to a plain writer
// (`out.line`) and are unaffected — leave those loops as-is.
export function commitBlockAbove(compositor: BlockCommitter, lines: readonly string[]): void {
  if (lines.length === 0) return;
  compositor.commitAbove(lines.join('\n'));
}
