/**
 * Text-input overlay for `ask_question` text / number elicitations.
 *
 * Sibling to {@link ./picker.ts} — same compositor `enterPickerMode`
 * mechanism, different controller. Where `runPicker` drives an
 * arrow-key selection state machine, `runTextInput` drives a
 * single-line editable buffer with a visible caret.
 *
 * UX shape:
 *
 * ```
 *   ? <question>
 *   > <buffer with █ caret>
 *   enter to submit · esc to cancel
 * ```
 *
 * On confirm: resolves with the buffer text (possibly empty — caller
 * decides whether to treat empty as skip).
 * On cancel (Esc / Ctrl+C / abort): resolves with `null`.
 *
 * Invariant: `runTextInput` MUST NOT call `setRawMode` or install its
 * own `stdin.on('keypress')` listener. All input flows through the
 * compositor's existing raw-mode pipeline (see picker.ts header for
 * the single-consumer stdin invariant — same applies here).
 */

import { palette } from '../palette.js';
import { InputCore, type InputCoreState } from '../input-core.js';
import type { PickerController } from '../terminal-compositor.js';
import type { PickerHost } from './picker.js';

export interface RunTextInputOptions {
  /**
   * Header lines rendered above the input row. Typically the question
   * prompt and any context lines. Rendered verbatim — colour/formatting
   * is the caller's responsibility.
   */
  header: readonly string[];
  /**
   * Initial buffer contents. Defaults to empty string. Cursor lands
   * at the end of the buffer (matching {@link InputCore.seed}).
   */
  initial?: string;
  /**
   * Help text rendered at the bottom of the overlay. Defaults to the
   * standard `enter to submit · esc to cancel` line.
   */
  help?: string;
  /**
   * Synchronous validator. Return `null` to accept the buffer on Enter;
   * return an error string to keep the overlay open and render the error
   * below the input row until the next keypress.
   *
   * Validation runs only on Enter — not on every keystroke — so users
   * can type freely without errors flickering as they go.
   */
  validate?: (value: string) => string | null;
  /**
   * Abort signal — when fired, the overlay resolves with `null` and
   * exits picker mode. Mirrors the elicitation-router cancellation
   * contract.
   */
  signal?: AbortSignal;
}

const DEFAULT_HELP_TEXT = 'enter to submit · esc to cancel';
const PROMPT_GLYPH = '>';

/**
 * Run a text-input overlay against a `PickerHost` (the same `TerminalCompositor`
 * the arrow-key picker uses). Resolves with the typed string or `null` on
 * cancel.
 *
 * Lifecycle (mirrors {@link ./picker.ts#runPicker}):
 * 1. `enterPickerMode` with a controller that captures buffer + cursor in
 *    the closure. The compositor renders the initial frame.
 * 2. Each keystroke updates the buffer via `InputCore.*` mutators and
 *    triggers `repaintPicker`. Enter validates and resolves; Esc/Ctrl+C
 *    cancels.
 * 3. On resolution, `exitPickerMode` is called once. The host restores
 *    the input region; caller is expected to commit a single-line echo
 *    to scrollback.
 *
 * Abort safety: same as `runPicker` — already-aborted signals short-circuit
 * before entering picker mode; mid-keystroke aborts exit cleanly.
 *
 * Invariant: `exitPickerMode()` is called EXACTLY ONCE on every path
 * (confirm, cancel, abort). A `resolved` guard prevents double-exit if
 * a key arrives after the picker has resolved but before the compositor
 * has stopped routing keys (single-tick race).
 */
export function runTextInput(
  host: PickerHost,
  opts: RunTextInputOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const { header, initial = '', help = DEFAULT_HELP_TEXT, validate, signal } = opts;

    if (signal?.aborted) {
      resolve(null);
      return;
    }

    let state: InputCoreState = InputCore.seed(initial);
    let errorLine: string | null = null;
    let resolved = false;

    const finish = (result: string | null): void => {
      if (resolved) return;
      resolved = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      host.exitPickerMode();
      resolve(result);
    };

    const onAbort = (): void => finish(null);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const renderRows = (): readonly string[] => {
      const lines: string[] = [];
      for (const h of header) lines.push(h);
      lines.push(renderInputRow(state));
      if (errorLine !== null) {
        lines.push(palette.warning('  ' + errorLine));
      }
      lines.push(palette.dim('  ' + help));
      return lines;
    };

    const onKey = (
      char: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
    ): void => {
      if (resolved) return;

      // Cancel: Esc OR Ctrl+C. Mirrors picker's cancel semantics.
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      }

      // Confirm: Enter triggers validation. On pass, resolve with buffer.
      // On fail, stash the error message and repaint — overlay stays open.
      if (key.name === 'return') {
        if (validate) {
          const err = validate(state.buffer);
          if (err !== null) {
            errorLine = err;
            host.repaintPicker();
            return;
          }
        }
        finish(state.buffer);
        return;
      }

      // Any other key clears a previously-shown error so the user sees
      // their edit reflected in the overlay without stale red text below.
      const hadError = errorLine !== null;

      // Navigation
      if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
        state = InputCore.moveLeft(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
        state = InputCore.moveRight(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
        state = InputCore.moveHome(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
        state = InputCore.moveEnd(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }

      // Backspace / Delete
      if (key.name === 'backspace') {
        state = InputCore.backspace(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.name === 'delete') {
        state = InputCore.deleteForward(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }

      // Word-level edits
      if (key.ctrl && key.name === 'w') {
        state = InputCore.deleteWordBackward(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        state = InputCore.deleteToLineStart(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }
      if (key.ctrl && key.name === 'k') {
        state = InputCore.deleteToLineEnd(state);
        errorLine = null;
        host.repaintPicker();
        return;
      }

      // Printable character — insert at cursor. `char` arrives undefined
      // for non-printable named keys (escape, return, etc., already
      // handled above); guard against control chars too.
      if (char !== undefined && char.length > 0 && !isControlChar(char)) {
        state = InputCore.insert(state, char);
        errorLine = null;
        host.repaintPicker();
        return;
      }

      // Unknown key with active error — clear it and repaint so the
      // overlay matches the user's expectation that "the next thing I
      // do" clears the error. Avoids stale errors lingering when the
      // user presses arrows / shift / etc. after a failed Enter.
      if (hadError) {
        errorLine = null;
        host.repaintPicker();
      }
    };

    const controller: PickerController = { renderRows, onKey };
    host.enterPickerMode(controller);
  });
}

/**
 * Render the single input row with an inverse-video caret at the
 * cursor position. Matches the compositor's main input rendering
 * (terminal-compositor.ts ~line 1253) so the overlay visually echoes
 * the persistent prompt the user is already used to.
 *
 * The buffer is rendered as `<before><caret><after>`, where `<caret>`
 * is one display cell of inverse video — either the character under
 * the cursor, or a space when the cursor sits past the buffer end.
 */
function renderInputRow(state: InputCoreState): string {
  const { buffer, cursor } = state;
  const before = buffer.slice(0, cursor);
  // Note: simple substring slice here — runTextInput is single-line and
  // the buffer is bounded by the input-core invariants, so we don't need
  // the full nextGraphemeIndex dance the compositor uses for the
  // persistent input. If a grapheme-split edge case surfaces in practice
  // we can swap in the grapheme-aware variant.
  const cursorChar = cursor < buffer.length ? buffer.charAt(cursor) : ' ';
  const after = cursor < buffer.length ? buffer.slice(cursor + 1) : '';
  const caret = palette.user.inverse(cursorChar);
  return `  ${palette.dim(PROMPT_GLYPH)} ${before}${caret}${after}`;
}

/**
 * Detect ASCII control characters that should not be inserted into
 * the buffer. Named keys (escape, return, …) already short-circuit
 * above via `key.name`; this guard catches stray control bytes that
 * arrive via `char` (e.g. Ctrl+H sent as `\x08` on some terminals).
 */
function isControlChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
