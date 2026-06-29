/**
 * Single source of truth for the Enter-key decision shared by both input
 * surfaces — the live `TerminalCompositor` (`handleEnter` in
 * terminal-compositor.input-dispatch.ts) and the legacy / non-TTY
 * `readWithAutocompleteTty` reader (`handleKeypress` in input/reader.ts).
 *
 * History: the two surfaces previously carried byte-cloned copies of this
 * logic that drifted. The trailing-backslash continuation lived only in the
 * reader, so `\`+Enter silently submitted the raw backslash in the live REPL
 * instead of inserting a newline. Extracting the decision into pure, testable
 * functions makes that class of drift structurally impossible.
 *
 * These are pure predicates — no I/O, no state mutation. Each surface keeps its
 * own side-effecting follow-through (applyEdit vs repaint, submit vs queue,
 * dropdown handling), but the BRANCH CONDITIONS now resolve identically.
 */

/** Minimal structural shape of a keypress payload these predicates read. Both
 *  surfaces' richer `KeyInfo` types satisfy it (only shift/meta are consulted). */
export interface EnterKeyModifiers {
  shift?: boolean;
  meta?: boolean;
}

/**
 * True when an Enter keystroke is an explicit soft-newline request rather than
 * a submit:
 *   - shift+Enter — most terminals report `key.shift` on Return.
 *   - `\x1b[13;2u` — the kitty keyboard-protocol fallback for shift+Enter in
 *     terminals that don't set `key.shift`.
 *   - alt/option+Enter — reported as `key.meta`.
 *
 * Invariant: the `\x1b[13;2u` sequence is an externally-governed terminal
 * protocol constant (kitty), not an arbitrary value — keep it byte-exact.
 * Terminals that report none of these fall back to the trailing-backslash
 * escape ({@link endsWithBackslashContinuation}).
 */
export function isSoftNewlineEnter(
  key: EnterKeyModifiers | undefined,
  sequence: string | undefined,
): boolean {
  const isShiftEnter = key?.shift === true || sequence === '\x1b[13;2u';
  const isAltEnter = key?.meta === true;
  return isShiftEnter || isAltEnter;
}

/**
 * True when the buffer ends in a trailing backslash — the documented escape
 * hatch that converts Enter into a real newline for terminals that don't report
 * shift-state on Return. The caller replaces the trailing `\` with `\n`.
 */
export function endsWithBackslashContinuation(buffer: string): boolean {
  return buffer.endsWith('\\');
}
