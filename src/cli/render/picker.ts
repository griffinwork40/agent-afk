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
 * On Esc / external abort signal: resolves with `null`.
 * On Ctrl+C: calls `opts.onCtrlC()` (if provided) then resolves with `null`.
 *
 * Invariant: the picker NEVER calls `setRawMode` or installs its own
 * `stdin.on('keypress')` listener. All input flows through the
 * compositor's existing raw-mode pipeline. Adding a second listener
 * would re-introduce the phantom-turn bug fixed in PR #511.
 */

import { palette } from '../palette.js';
import type { PickerController } from '../terminal-compositor.js';
import { filterOptions } from './picker-filter.js';

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
  /**
   * Called when Ctrl+C is pressed inside the picker, BEFORE `finish(null)`
   * resolves the promise. Use this to fire a hard-cancel action immediately
   * so the picker's `null` resolution is not confused with an Esc/dismiss.
   *
   * Without this callback, Ctrl+C behaves identically to Esc (resolves
   * `null`). With it, the hard-cancel fires synchronously on Ctrl+C while
   * the picker still cleans up normally.
   */
  onCtrlC?: () => void;
  /**
   * Enable fuzzy search overlay. When `true`, printable characters append
   * to a filter query that narrows the visible options. Esc with a
   * non-empty query clears the filter; Esc with an empty query cancels the
   * picker. Backspace removes the last filter character.
   *
   * Only the `/resume` caller passes `searchable: true`. The elicitation
   * picker and config-menu do NOT pass it and get the unchanged behaviour.
   */
  searchable?: boolean;
}

const GLYPH_CURSOR = '▸';
const GLYPH_GUTTER = ' ';
const GLYPH_BOX_CHECKED = '◉';
const GLYPH_BOX_UNCHECKED = '◯';

const HELP_SINGLE = '↑/↓ navigate · enter select · esc cancel';
const HELP_MULTI = '↑/↓ navigate · space toggle · enter confirm · esc cancel';
const HELP_SEARCH = '↑/↓ navigate · enter select · esc clear/cancel · type to filter';

/** Number of option rows shown in the viewport at once. */
const WINDOW_SIZE = 20;

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
 *    - Esc cancels — resolves with `null`.
 *    - Ctrl+C calls `opts.onCtrlC()` (if provided) then resolves with `null`.
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
    const {
      header,
      options,
      multi = false,
      signal,
      initialIndex = 0,
      onCtrlC,
      searchable = false,
    } = opts;

    if (options.length === 0) {
      resolve(null);
      return;
    }
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    // --- filter / search state (searchable mode only) ---
    let filterQuery = '';
    // filteredResults mirrors filterOptions() output; rebuilt on every query change.
    let filteredResults = filterOptions(options, filterQuery);

    /** The live option set (filtered when searchable, full list otherwise). */
    const activeOptions = (): readonly string[] =>
      searchable
        ? filteredResults.map((r) => options[r.originalIndex] ?? '')
        : options;

    // --- virtual-scroll state ---
    let cursor = clamp(initialIndex, 0, options.length - 1);
    let scrollOffset = 0;

    /** Clamp cursor to the current active-option range and adjust scroll. */
    const clampCursorAndScroll = (): void => {
      const len = activeOptions().length;
      if (len === 0) {
        cursor = 0;
        scrollOffset = 0;
        return;
      }
      cursor = clamp(cursor, 0, len - 1);
      // Keep cursor in the visible window.
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + WINDOW_SIZE) scrollOffset = cursor - WINDOW_SIZE + 1;
      scrollOffset = clamp(scrollOffset, 0, Math.max(0, len - WINDOW_SIZE));
    };

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

      // Filter input row (searchable mode).
      if (searchable) {
        lines.push(palette.dim('  Filter: ') + filterQuery + '█');
      }

      const ao = activeOptions();
      const len = ao.length;

      // Virtual-scroll window.
      const visStart = scrollOffset;
      const visEnd = Math.min(scrollOffset + WINDOW_SIZE, len);

      for (let vi = visStart; vi < visEnd; vi++) {
        const label = ao[vi] ?? '';
        const isCursor = vi === cursor;
        const cursorGlyph = isCursor ? palette.brand(GLYPH_CURSOR) : GLYPH_GUTTER;
        let row: string;
        if (multi) {
          // In searchable+multi we track selection by originalIndex.
          const origIdx = searchable
            ? (filteredResults[vi]?.originalIndex ?? vi)
            : vi;
          const isChecked = selected.has(origIdx);
          const box = isChecked
            ? palette.success(GLYPH_BOX_CHECKED)
            : palette.dim(GLYPH_BOX_UNCHECKED);
          const labelStyled =
            isCursor && !isChecked ? palette.bold(label) : label;
          row = `  ${cursorGlyph} ${box} ${labelStyled}`;
        } else {
          const labelStyled = isCursor ? palette.bold(label) : palette.dim(label);
          row = `  ${cursorGlyph} ${labelStyled}`;
        }
        lines.push(row);
      }

      // Scroll indicator — shown when the list is longer than the window.
      if (len > WINDOW_SIZE) {
        const lo = visStart + 1;
        const hi = visEnd;
        lines.push(palette.dim(`  (${lo}–${hi} of ${len}  ↑/↓ scroll)`));
      }

      const helpText = searchable ? HELP_SEARCH : multi ? HELP_MULTI : HELP_SINGLE;
      lines.push(palette.dim('  ' + helpText));
      return lines;
    };

    const onKey = (
      _char: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
    ): void => {
      if (resolved) return;

      // Esc: clear filter if non-empty (searchable); otherwise dismiss.
      if (key.name === 'escape') {
        if (searchable && filterQuery.length > 0) {
          filterQuery = '';
          filteredResults = filterOptions(options, filterQuery);
          cursor = 0;
          scrollOffset = 0;
          host.repaintPicker();
          return;
        }
        finish(null);
        return;
      }

      // Ctrl+C: hard-cancel safety hatch.
      if (key.ctrl && key.name === 'c') {
        onCtrlC?.();
        finish(null);
        return;
      }

      // Backspace in searchable mode removes last filter char.
      if (searchable && (key.name === 'backspace' || key.name === 'delete')) {
        if (filterQuery.length > 0) {
          filterQuery = filterQuery.slice(0, -1);
          filteredResults = filterOptions(options, filterQuery);
          cursor = 0;
          scrollOffset = 0;
          host.repaintPicker();
        }
        return;
      }

      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        const len = activeOptions().length;
        cursor = cursor === 0 ? len - 1 : cursor - 1;
        clampCursorAndScroll();
        host.repaintPicker();
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        const len = activeOptions().length;
        cursor = cursor === len - 1 ? 0 : cursor + 1;
        clampCursorAndScroll();
        host.repaintPicker();
        return;
      }

      if (key.name === 'return') {
        if (multi) {
          const out: string[] = [];
          for (let i = 0; i < options.length; i++) {
            if (selected.has(i)) {
              const v = options[i];
              if (v !== undefined) out.push(v);
            }
          }
          finish(out);
        } else {
          // Resolve with the ORIGINAL option label (not the filtered view label)
          // so that resume.ts's `options.indexOf(choice)` lookup still works.
          const origIdx = searchable
            ? (filteredResults[cursor]?.originalIndex ?? cursor)
            : cursor;
          const v = options[origIdx];
          finish(v !== undefined ? [v] : []);
        }
        return;
      }

      if (multi && (key.name === 'space' || _char === ' ')) {
        const origIdx = searchable
          ? (filteredResults[cursor]?.originalIndex ?? cursor)
          : cursor;
        if (selected.has(origIdx)) selected.delete(origIdx);
        else selected.add(origIdx);
        host.repaintPicker();
        return;
      }

      if (key.name === 'home') {
        cursor = 0;
        scrollOffset = 0;
        host.repaintPicker();
        return;
      }
      if (key.name === 'end') {
        cursor = activeOptions().length - 1;
        clampCursorAndScroll();
        host.repaintPicker();
        return;
      }

      // Printable char in searchable mode: append to filter query.
      if (searchable && _char !== undefined && _char.length === 1 && !key.ctrl && !key.meta) {
        const code = _char.codePointAt(0) ?? 0;
        if (code >= 0x20) {
          filterQuery += _char;
          filteredResults = filterOptions(options, filterQuery);
          cursor = 0;
          scrollOffset = 0;
          host.repaintPicker();
          return;
        }
      }

      // All other keys are swallowed (printable chars when not searchable, Tab,
      // etc.) so they don't leak into a buried input buffer. The compositor's
      // picker-mode short-circuit (terminal-compositor.ts:dispatchKey) already
      // ensures this, but ignoring here is defence-in-depth.
    };

    // Initialise scroll after cursor is set.
    clampCursorAndScroll();

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
