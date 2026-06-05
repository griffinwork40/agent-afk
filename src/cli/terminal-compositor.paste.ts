/**
 * Paste-truncation: bracketed-paste collapse + placeholder expand/delete.
 *
 * Extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by src/cli/_lib/stream-renderer-*: TerminalCompositor owns the
 * state; these functions operate on the narrow {@link PasteHost} slice it
 * passes as `self`. No behavior change — bodies are byte-for-byte moves with
 * `this.` rewritten to `self.`.
 */

import { randomBytes } from 'node:crypto';
import { InputCore, type InputCoreState } from './input-core.js';

/**
 * Paste-truncation thresholds — see {@link maybeTruncatePaste}.
 *
 * A bracketed-paste burst whose pasted span contains >= NEWLINE_THRESHOLD
 * newlines (i.e. NEWLINE_THRESHOLD + 1 or more visual lines) OR
 * >= CHAR_THRESHOLD characters is collapsed into a compact
 * `[Pasted text #N +M lines]` (or `+M chars`) placeholder in the input
 * buffer. The original content is stashed in `pasteRegistry` and
 * re-expanded at submit. Small pastes (multi-line code snippets,
 * sub-1KB blobs) stay inline so the user can still see them.
 *
 * Tuned to hide pastes that would otherwise consume a noticeable
 * chunk of the input area while keeping common short pastes (errors,
 * short code blocks) visible. Adjust here, not via env, until a real
 * tuning need surfaces.
 */
const PASTE_NEWLINE_THRESHOLD = 5;
const PASTE_CHAR_THRESHOLD = 1000;

/**
 * Recognizer for paste placeholders inside the live buffer. Captures
 * the registry id in group 1.
 *
 * Used in three places:
 *   1. {@link expandPastePlaceholders} — expand at submit.
 *   2. {@link maybeAtomicPlaceholderDelete} — atomic backspace.
 *   3. {@link ./input-highlight.ts} — visual styling (anchored copy lives there).
 *
 * The literal `[Pasted text #` prefix is distinctive enough that
 * accidental user-typed strings won't collide in practice; the cost
 * of a false positive is purely cosmetic (a stretch of text rendered
 * dim that the user did NOT paste). Registry expansion is safe — an
 * id that isn't in the map falls through as the literal token.
 */
const PASTE_PLACEHOLDER_RE = /\[Pasted text #([0-9a-f]+) \+\d+ (?:lines|chars)\]/g;

/**
 * Format a placeholder token for a freshly-stashed paste. Multi-line
 * pastes report a line count (newlines + 1, so a single-newline paste
 * shows `+2 lines`); single-line pastes report a char count.
 */
function formatPastePlaceholder(id: string, content: string): string {
  const newlineMatches = content.match(/\n/g);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  if (newlineCount > 0) {
    return `[Pasted text #${id} +${newlineCount + 1} lines]`;
  }
  return `[Pasted text #${id} +${content.length} chars]`;
}

/**
 * Narrowest TerminalCompositor state slice the paste functions touch.
 * `pasteRegistry` is mutated in-place (never reassigned) so it stays a
 * `readonly` view; `input` is reassigned by {@link maybeTruncatePaste}.
 */
export interface PasteHost {
  /** Side-table mapping placeholder id → original pasted content. */
  readonly pasteRegistry: Map<string, string>;
  /** Insertion cursor snapshotted at bracketed-paste start. */
  readonly pasteStartCursor: number;
  /** Live input buffer state — reassigned by maybeTruncatePaste. */
  input: InputCoreState;
}

export function expandPastePlaceholders(self: PasteHost, buffer: string): string {
  if (self.pasteRegistry.size === 0) return buffer;
  // Reset RegExp.lastIndex semantics: PASTE_PLACEHOLDER_RE has the
  // `g` flag, so per-call `replace` resets internal state correctly.
  return buffer.replace(PASTE_PLACEHOLDER_RE, (token, idStr: string) => {
    const entry = self.pasteRegistry.get(idStr);
    return entry ?? token;
  });
}

/**
 * After a bracketed paste ends, check whether the pasted span is
 * large enough to warrant collapsing into a `[Pasted text #N +M lines]`
 * placeholder. The original content is stashed in pasteRegistry and
 * re-expanded at submit.
 *
 * Called from the `\x1b[201~` handler in dispatchKey AFTER `pasting`
 * has been flipped back to false, BEFORE the post-paste repaint, so
 * the first frame the user sees already shows the placeholder
 * instead of the full pasted span.
 *
 * Skips the swap when:
 *   - The paste was empty (handled by zero-char branch upstream).
 *   - The span is shorter than both thresholds (small pastes stay
 *     inline so users can see what they pasted).
 *   - The cursor moved unexpectedly (`endCursor < startCursor`,
 *     shouldn't happen — defensive bail).
 *
 * Bypasses applyEdit because:
 *   1. The end-of-paste path explicitly repaints once afterwards.
 *   2. The placeholder is mechanical, not user input — no
 *      `history.resetRecall()` semantics apply.
 *   3. Autocomplete is already suppressed during paste (applyEdit
 *      bails on `this.pasting`); the next applyEdit call after
 *      the user resumes typing recomputes it from the placeholder
 *      buffer.
 */
export function maybeTruncatePaste(self: PasteHost): void {
  const startCursor = self.pasteStartCursor;
  const endCursor = self.input.cursor;
  if (endCursor <= startCursor) return;

  const rawPasted = self.input.buffer.slice(startCursor, endCursor);
  // Invariant: strip embedded bracketed-paste sentinels from clipboard content.
  // If a clipboard payload contains literal \x1b[200~ or \x1b[201~ bytes, the
  // terminal's end-sentinel (\x1b[201~) fires early, causing subsequent bytes
  // to be dispatched as live keystrokes. Strip them from the stashed content so
  // re-expansion at submit does not replay sentinel sequences into the model.
  const pasted = rawPasted.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  const newlineMatches = pasted.match(/\n/g);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  const charCount = pasted.length;

  if (newlineCount < PASTE_NEWLINE_THRESHOLD && charCount < PASTE_CHAR_THRESHOLD) {
    return;
  }

  const id = randomBytes(4).toString('hex');
  self.pasteRegistry.set(id, pasted);
  const placeholder = formatPastePlaceholder(id, pasted);
  // Swap the pasted span for the placeholder. Cursor lands at end
  // of placeholder — same affordance as the user just finished
  // pasting (they can immediately type a trailing space, Enter,
  // etc. without manually moving the cursor).
  self.input = InputCore.replaceRange(
    self.input,
    { start: startCursor, end: endCursor },
    placeholder,
  );
}

/**
 * If the cursor sits at the trailing `]` of a paste placeholder
 * (backward) or at the leading `[` (forward), return the InputCore
 * state that would result from deleting the whole token. Drops the
 * registry entry as part of the same operation so a deleted
 * placeholder doesn't leak its expansion at submit. Returns null
 * when the cursor is NOT adjacent to a placeholder boundary —
 * caller falls through to the regular backspace/delete code path.
 *
 * This makes single-Backspace feel atomic for the user: hitting
 * Backspace once after pasting deletes the entire `[Pasted text
 * #N +M lines]` token instead of nibbling away one char at a time.
 * Cursor positioning inside the token still allows char-by-char
 * editing (escape hatch); if the user breaks the token's structural
 * chars (`[`, `]`, `#`, `lines`/`chars`) mid-edit, the broken
 * literal is sent to the model at submit (original content lost).
 * Numeric edits are safe — `\+\d+` still matches. Registry entry
 * is cleared on next submit / disarm cycle regardless.
 */
export function maybeAtomicPlaceholderDelete(
  self: PasteHost,
  direction: 'backward' | 'forward',
): InputCoreState | null {
  if (self.pasteRegistry.size === 0) return null;
  const buf = self.input.buffer;
  const cur = self.input.cursor;
  if (direction === 'backward') {
    // Anchor at end-of-slice — match a placeholder ending exactly
    // at the cursor. `$` against a sliced prefix is the canonical
    // way to do this without lookbehind length quirks.
    const m = /\[Pasted text #([0-9a-f]+) \+\d+ (?:lines|chars)\]$/.exec(buf.slice(0, cur));
    if (!m) return null;
    const start = cur - m[0].length;
    // The match guarantees group 1 captured at least one hex char —
    // non-null assertion documents the regex invariant.
    const idStr = m[1]!;
    // Invariant: replaceRange before delete so a throw leaves the
    // registry intact (registry entry is recoverable at next submit).
    const result = InputCore.replaceRange(self.input, { start, end: cur }, '');
    self.pasteRegistry.delete(idStr);
    return result;
  }
  const m = /^\[Pasted text #([0-9a-f]+) \+\d+ (?:lines|chars)\]/.exec(buf.slice(cur));
  if (!m) return null;
  const end = cur + m[0].length;
  const idStr = m[1]!;
  // Invariant: replaceRange before delete — same ordering guarantee as
  // the backward branch above.
  const result = InputCore.replaceRange(self.input, { start: cur, end }, '');
  self.pasteRegistry.delete(idStr);
  return result;
}
