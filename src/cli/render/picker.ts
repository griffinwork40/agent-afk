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
  /** Current terminal height, when the host can report it. */
  terminalRows?(): number | undefined;
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

// ---------------------------------------------------------------------------
// Mutable picker state — passed by reference to extracted helpers so they
// can read and update cursor / scroll / filter without closures.
// ---------------------------------------------------------------------------

/** All mutable state that drives picker rendering and key handling. */
export interface PickerState {
  cursor: number;
  scrollOffset: number;
  filterQuery: string;
  filteredResults: ReturnType<typeof filterOptions>;
  selected: Set<number>;
}

// ---------------------------------------------------------------------------
// Extracted helper: renderPickerRows
// ---------------------------------------------------------------------------

/**
 * Build the full row list for one repaint of the picker UI.
 *
 * All arguments are explicit — no closures over `runPicker` locals — so
 * this function can be unit-tested independently of the promise machinery.
 *
 * Side-effect: calls `clampPickerScroll` to keep `state.cursor` and
 * `state.scrollOffset` consistent before computing visible rows. This
 * matches the original `renderRows` behaviour (clampCursorAndScroll was
 * called at the top of every render).
 */
export function renderPickerRows(
  state: PickerState,
  header: readonly string[],
  options: readonly string[],
  multi: boolean,
  searchable: boolean,
  terminalRowsFn: (() => number | undefined) | undefined,
): readonly string[] {
  const lines: string[] = [];
  for (const h of header) lines.push(h);

  // Filter input row (searchable mode).
  if (searchable) {
    lines.push(palette.dim('  Filter: ') + state.filterQuery + '█');
  }

  const ao = pickerActiveOptions(state, options, searchable);
  const len = ao.length;
  const windowSize = pickerViewportSize(terminalRowsFn, header.length, searchable, len);
  clampPickerScroll(state, ao, windowSize);

  // Virtual-scroll window.
  const visStart = state.scrollOffset;
  const visEnd = Math.min(state.scrollOffset + windowSize, len);

  for (let vi = visStart; vi < visEnd; vi++) {
    const label = ao[vi] ?? '';
    const isCursor = vi === state.cursor;
    const cursorGlyph = isCursor ? palette.brand(GLYPH_CURSOR) : GLYPH_GUTTER;
    let row: string;
    if (multi) {
      // In searchable+multi we track selection by originalIndex.
      const origIdx = searchable
        ? (state.filteredResults[vi]?.originalIndex ?? vi)
        : vi;
      const isChecked = state.selected.has(origIdx);
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
  if (len > windowSize) {
    const lo = visStart + 1;
    const hi = visEnd;
    lines.push(palette.dim(`  (${lo}–${hi} of ${len}  ↑/↓ scroll)`));
  }

  const helpText = searchable ? HELP_SEARCH : multi ? HELP_MULTI : HELP_SINGLE;
  lines.push(palette.dim('  ' + helpText));
  return lines;
}

// ---------------------------------------------------------------------------
// Extracted helper: handlePickerKey
// ---------------------------------------------------------------------------

/**
 * Dispatch one keystroke through the picker state machine.
 *
 * Returns a `PickerKeyAction` telling the caller what to do next.
 * The caller (inside `runPicker`) owns `finish()` and `host.repaintPicker()`;
 * this function only mutates `state` and returns an intent.
 *
 * All arguments are explicit — no closures over `runPicker` locals.
 */
export type PickerKeyAction =
  | { kind: 'repaint' }
  | { kind: 'finish'; result: readonly string[] | null }
  | { kind: 'ctrlc' }    // call onCtrlC() then finish(null)
  | { kind: 'noop' };

export function handlePickerKey(
  state: PickerState,
  options: readonly string[],
  multi: boolean,
  searchable: boolean,
  _char: string | undefined,
  key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
): PickerKeyAction {
  // Esc: clear filter if non-empty (searchable); otherwise dismiss.
  if (key.name === 'escape') {
    if (searchable && state.filterQuery.length > 0) {
      state.filterQuery = '';
      state.filteredResults = filterOptions(options, state.filterQuery);
      state.cursor = 0;
      state.scrollOffset = 0;
      return { kind: 'repaint' };
    }
    return { kind: 'finish', result: null };
  }

  // Ctrl+C: hard-cancel safety hatch.
  if (key.ctrl && key.name === 'c') {
    return { kind: 'ctrlc' };
  }

  // Backspace in searchable mode removes last filter char.
  if (searchable && (key.name === 'backspace' || key.name === 'delete')) {
    if (state.filterQuery.length > 0) {
      state.filterQuery = state.filterQuery.slice(0, -1);
      state.filteredResults = filterOptions(options, state.filterQuery);
      state.cursor = 0;
      state.scrollOffset = 0;
      return { kind: 'repaint' };
    }
    return { kind: 'noop' };
  }

  const ao = pickerActiveOptions(state, options, searchable);

  if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
    const len = ao.length;
    state.cursor = state.cursor === 0 ? len - 1 : state.cursor - 1;
    const windowSize = pickerViewportSize(undefined, 0, searchable, len);
    clampPickerScroll(state, ao, windowSize);
    return { kind: 'repaint' };
  }
  if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
    const len = ao.length;
    state.cursor = state.cursor === len - 1 ? 0 : state.cursor + 1;
    const windowSize = pickerViewportSize(undefined, 0, searchable, len);
    clampPickerScroll(state, ao, windowSize);
    return { kind: 'repaint' };
  }

  if (key.name === 'return') {
    // An empty filtered view has no highlighted option to confirm.
    if (searchable && state.filteredResults.length === 0) return { kind: 'noop' };
    if (multi) {
      const out: string[] = [];
      for (let i = 0; i < options.length; i++) {
        if (state.selected.has(i)) {
          const v = options[i];
          if (v !== undefined) out.push(v);
        }
      }
      return { kind: 'finish', result: out };
    } else {
      // Resolve with the ORIGINAL option label (not the filtered view label)
      // so that resume.ts's `options.indexOf(choice)` lookup still works.
      const origIdx = searchable
        ? (state.filteredResults[state.cursor]?.originalIndex ?? state.cursor)
        : state.cursor;
      const v = options[origIdx];
      return { kind: 'finish', result: v !== undefined ? [v] : [] };
    }
  }

  if (multi && (key.name === 'space' || _char === ' ')) {
    const origIdx = searchable
      ? (state.filteredResults[state.cursor]?.originalIndex ?? state.cursor)
      : state.cursor;
    if (state.selected.has(origIdx)) state.selected.delete(origIdx);
    else state.selected.add(origIdx);
    return { kind: 'repaint' };
  }

  if (key.name === 'home') {
    state.cursor = 0;
    state.scrollOffset = 0;
    return { kind: 'repaint' };
  }
  if (key.name === 'end') {
    state.cursor = ao.length - 1;
    const windowSize = pickerViewportSize(undefined, 0, searchable, ao.length);
    clampPickerScroll(state, ao, windowSize);
    return { kind: 'repaint' };
  }

  // Printable char in searchable mode: append to filter query.
  if (searchable && _char !== undefined && _char.length === 1 && !key.ctrl && !key.meta) {
    const code = _char.codePointAt(0) ?? 0;
    if (code >= 0x20) {
      state.filterQuery += _char;
      state.filteredResults = filterOptions(options, state.filterQuery);
      state.cursor = 0;
      state.scrollOffset = 0;
      return { kind: 'repaint' };
    }
  }

  // All other keys are swallowed (printable chars when not searchable, Tab,
  // etc.) so they don't leak into a buried input buffer. The compositor's
  // picker-mode short-circuit (terminal-compositor.ts:dispatchKey) already
  // ensures this, but ignoring here is defence-in-depth.
  return { kind: 'noop' };
}

// ---------------------------------------------------------------------------
// Internal pure helpers (not exported — used by both renderPickerRows and
// handlePickerKey)
// ---------------------------------------------------------------------------

/** The live option set (filtered when searchable, full list otherwise). */
function pickerActiveOptions(
  state: PickerState,
  options: readonly string[],
  searchable: boolean,
): readonly string[] {
  return searchable
    ? state.filteredResults.map((r) => options[r.originalIndex] ?? '')
    : options;
}

/** Option rows that fit without crossing the compositor's bottom margin. */
function pickerViewportSize(
  terminalRowsFn: (() => number | undefined) | undefined,
  headerLength: number,
  searchable: boolean,
  optionCount: number,
): number {
  const terminalRows = terminalRowsFn?.();
  if (terminalRows === undefined) return WINDOW_SIZE;
  const fixedRows = headerLength + (searchable ? 1 : 0) + 1;
  const withoutIndicator = Math.max(0, terminalRows - 1 - fixedRows);
  const indicatorRows = optionCount > Math.min(WINDOW_SIZE, withoutIndicator) ? 1 : 0;
  return Math.min(WINDOW_SIZE, Math.max(0, withoutIndicator - indicatorRows));
}

/** Clamp cursor to the current active-option range and adjust scroll offset. */
function clampPickerScroll(
  state: PickerState,
  ao: readonly string[],
  windowSize: number,
): void {
  const len = ao.length;
  if (len === 0) {
    state.cursor = 0;
    state.scrollOffset = 0;
    return;
  }
  state.cursor = clamp(state.cursor, 0, len - 1);
  // Keep cursor in the visible window.
  if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;
  if (windowSize > 0 && state.cursor >= state.scrollOffset + windowSize) {
    state.scrollOffset = state.cursor - windowSize + 1;
  }
  state.scrollOffset = clamp(state.scrollOffset, 0, Math.max(0, len - windowSize));
}

// ---------------------------------------------------------------------------
// runPicker — public entry point
// ---------------------------------------------------------------------------

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

    const state: PickerState = {
      cursor: clamp(initialIndex, 0, options.length - 1),
      scrollOffset: 0,
      filterQuery: '',
      filteredResults: filterOptions(options, ''),
      selected: new Set<number>(opts.initialSelected ?? []),
    };

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

    const renderRows = (): readonly string[] =>
      renderPickerRows(state, header, options, multi, searchable, host.terminalRows?.bind(host));

    const onKey = (
      _char: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
    ): void => {
      if (resolved) return;
      const action = handlePickerKey(state, options, multi, searchable, _char, key);
      if (action.kind === 'repaint') {
        host.repaintPicker();
      } else if (action.kind === 'finish') {
        finish(action.result);
      } else if (action.kind === 'ctrlc') {
        onCtrlC?.();
        finish(null);
      }
      // 'noop' → do nothing
    };

    // Initialise scroll after cursor is set.
    const ao = pickerActiveOptions(state, options, searchable);
    const windowSize = pickerViewportSize(host.terminalRows?.bind(host), header.length, searchable, ao.length);
    clampPickerScroll(state, ao, windowSize);

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
