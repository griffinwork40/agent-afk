/**
 * Arrow-key picker for `ask_question` choice / multi_choice elicitations.
 *
 * Lives entirely on top of `TerminalCompositor.enterPickerMode` — the
 * picker is a state machine that delegates rendering and keystroke
 * dispatch to the compositor (preserving the single-consumer stdin
 * invariant — see HOT memory "Single-consumer stdin invariant (#511)").
 *
 * UX shape (inquirer.js conventions):
 *
 * ```
 *   ? Which option?
 *   ▸ Option A
 *     Option B
 *     Option C
 *   ↑/↓ to navigate · enter to select · esc to cancel
 * ```
 *
 * For multi-select:
 *
 * ```
 *   ? Pick any (space to toggle)
 *   ▸ ◉ Option A
 *     ◯ Option B
 *     ◉ Option C
 *   ↑/↓ navigate · space toggle · enter confirm · esc cancel
 * ```
 *
 * On confirm: `runPicker` resolves with the array of selected values
 * (single-element for `choice`). The compositor exits picker mode and
 * the entire frame disappears — restoring the live prompt row.
 *
 * On cancel (Esc / Ctrl+C / external abort signal): resolves with `null`.
 *
 * Invariant: the picker NEVER calls `setRawMode` or installs its own
 * `stdin.on('keypress')` listener. All input flows through the
 * compositor's existing raw-mode pipeline. Adding a second listener
 * would re-introduce the phantom-turn bug fixed in PR #511.
 */

import { palette } from '../palette.js';
import type { PickerController } from '../terminal-compositor.js';

/**
 * Minimal surface area the picker needs from a `TerminalCompositor`.
 * Declared as a structural type so tests can drop in a fake compositor
 * without constructing the full class (which owns log-update + raw mode
 * and is awkward to instantiate in a unit test).
 *
 * Contract:
 * - `enterPickerMode(c)` MUST repaint synchronously so the picker is
 *   visible before the first keystroke arrives.
 * - `exitPickerMode()` is idempotent — `runPicker` calls it from both
 *   the confirm path and the abort cleanup, so a no-op second call
 *   must not throw.
 * - `repaintPicker()` is called by the picker after each state change
 *   (selection move, toggle). The compositor reads `renderRows()`
 *   afresh on every repaint, so the picker just mutates its state
 *   and triggers a repaint — no need to push rows manually.
 */
export interface PickerHost {
  enterPickerMode(controller: PickerController): void;
  exitPickerMode(): void;
  repaintPicker(): void;
}

export interface RunPickerOptions {
  /**
   * Header lines rendered above the options. Typically the question
   * prompt and any context lines. Rendered as-is — colour/formatting
   * is the caller's responsibility.
   */
  header: readonly string[];
  /**
   * Selectable options. Each entry's label is rendered verbatim;
   * the value returned on confirm is the same string.
   */
  options: readonly string[];
  /**
   * Multi-select mode — space toggles, enter confirms the current
   * set. Default `false` (single-select; enter confirms the highlighted
   * row immediately).
   */
  multi?: boolean;
  /**
   * Abort signal — when fired, the picker resolves with `null` and
   * exits picker mode. Mirrors the elicitation-router cancellation
   * contract.
   */
  signal?: AbortSignal;
  /**
   * Initial selection index. Default `0`. Clamped to valid range.
   */
  initialIndex?: number;
  /**
   * Optional defaults for multi-select — set of indices to pre-toggle.
   * Ignored when `multi !== true`.
   */
  initialSelected?: ReadonlySet<number>;
}

const GLYPH_CURSOR = '▸';
const GLYPH_GUTTER = ' ';
const GLYPH_BOX_CHECKED = '◉';
const GLYPH_BOX_UNCHECKED = '◯';

const HELP_SINGLE = '↑/↓ navigate · enter select · esc cancel';
const HELP_MULTI = '↑/↓ navigate · space toggle · enter confirm · esc cancel';

/**
 * Run an arrow-key picker against a `PickerHost` (typically a
 * `TerminalCompositor`). Resolves with the selected value(s), or
 * `null` if the user cancels.
 *
 * Lifecycle:
 * 1. `enterPickerMode` with a controller that captures the picker's
 *    state-machine state inside the closure. The compositor renders
 *    the initial frame.
 * 2. Each keystroke dispatches through the controller's `onKey`:
 *    - Up/Down move the cursor.
 *    - Space toggles (multi only).
 *    - Enter confirms — resolves with the selected value(s).
 *    - Esc / Ctrl+C cancels — resolves with `null`.
 * 3. On resolution, `exitPickerMode` is called once. The host
 *    restores the input region.
 *
 * Abort safety:
 * - If `signal` is already aborted on entry, returns `null` without
 *   ever entering picker mode (no UI flash).
 * - If `signal` fires mid-keystroke, the picker is exited and `null`
 *   is returned. The abort handler is removed on every exit path.
 *
 * Invariant: `exitPickerMode()` is called EXACTLY ONCE on every path
 * (confirm, cancel, abort). A `resolved` guard prevents double-exit
 * if a key arrives after the picker has resolved but before the
 * compositor has stopped routing keys (single-tick race).
 */
export function runPicker(
  host: PickerHost,
  opts: RunPickerOptions,
): Promise<readonly string[] | null> {
  return new Promise((resolve) => {
    const { header, options, multi = false, signal, initialIndex = 0 } = opts;

    if (options.length === 0) {
      resolve(null);
      return;
    }
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    let cursor = clamp(initialIndex, 0, options.length - 1);
    const selected = new Set<number>(opts.initialSelected ?? []);
    let resolved = false;

    const finish = (result: readonly string[] | null): void => {
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
      for (let i = 0; i < options.length; i++) {
        const label = options[i] ?? '';
        const isCursor = i === cursor;
        const cursorGlyph = isCursor ? palette.brand(GLYPH_CURSOR) : GLYPH_GUTTER;
        let row: string;
        if (multi) {
          const isChecked = selected.has(i);
          const box = isChecked ? palette.success(GLYPH_BOX_CHECKED) : palette.dim(GLYPH_BOX_UNCHECKED);
          // Highlight the row label only when the cursor is on it AND
          // it's unchecked — checked items get green; cursor-on-checked
          // would over-stack styles. Cursor-on-unchecked: bold the label
          // for distinctness from the dim un-cursored rows.
          const labelStyled = isCursor && !isChecked ? palette.bold(label) : label;
          row = `  ${cursorGlyph} ${box} ${labelStyled}`;
        } else {
          const labelStyled = isCursor ? palette.bold(label) : palette.dim(label);
          row = `  ${cursorGlyph} ${labelStyled}`;
        }
        lines.push(row);
      }
      lines.push(palette.dim('  ' + (multi ? HELP_MULTI : HELP_SINGLE)));
      return lines;
    };

    const onKey = (
      _char: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
    ): void => {
      if (resolved) return;
      // Cancel: Esc OR Ctrl+C. Mirrors the existing elicitation cancel
      // semantics — picker UX matches what `:cancel` did in the
      // numbered-text fallback (drop the question, return cancel).
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      }
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        cursor = cursor === 0 ? options.length - 1 : cursor - 1;
        host.repaintPicker();
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        cursor = cursor === options.length - 1 ? 0 : cursor + 1;
        host.repaintPicker();
        return;
      }
      if (key.name === 'return') {
        if (multi) {
          // Empty multi-select selection is allowed — callers can decide
          // whether to treat it as "skip" downstream. Returning the
          // (possibly empty) selection lets the caller distinguish
          // "confirmed with no items" from "cancelled".
          const out: string[] = [];
          for (let i = 0; i < options.length; i++) {
            if (selected.has(i)) {
              const v = options[i];
              if (v !== undefined) out.push(v);
            }
          }
          finish(out);
        } else {
          const v = options[cursor];
          finish(v !== undefined ? [v] : []);
        }
        return;
      }
      if (multi && (key.name === 'space' || _char === ' ')) {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        host.repaintPicker();
        return;
      }
      // Home/End jumps — quality-of-life additions; cheap to implement
      // and standard in inquirer-style pickers.
      if (key.name === 'home') {
        cursor = 0;
        host.repaintPicker();
        return;
      }
      if (key.name === 'end') {
        cursor = options.length - 1;
        host.repaintPicker();
        return;
      }
      // All other keys are swallowed (printable chars, Tab, etc.) so
      // they don't leak into a buried input buffer. The compositor's
      // picker-mode short-circuit (terminal-compositor.ts:dispatchKey)
      // already ensures this, but ignoring here is defence-in-depth.
    };

    const controller: PickerController = { renderRows, onKey };
    host.enterPickerMode(controller);
  });
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
