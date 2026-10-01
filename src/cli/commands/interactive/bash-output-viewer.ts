/**
 * In-TUI scrollable viewer for captured bash output.
 *
 * Entered when the user presses Ctrl+G at the idle prompt when the most
 * recent bash tool call produced a capture file (soft-cap exceeded).
 * Reuses the compositor's existing `enterPickerMode` / `exitPickerMode`
 * machinery so no second stdin listener is ever installed (single-consumer
 * stdin invariant, #511).
 *
 * UX contract:
 *   ↑ / ↓        — scroll one line
 *   PgUp / PgDn  — scroll one screenful
 *   g / Home     — jump to top
 *   G / End      — jump to bottom
 *   /            — enter search mode (type query, Enter confirms)
 *   n            — next match
 *   N            — previous match
 *   Esc          — clear search (when query active) / close viewer
 *   q            — close viewer
 *
 * Architecture: thin rendering shell around the pure {@link ViewerState}
 * model in {@link bash-output-viewer-model.ts}. The renderer is entirely
 * inside `renderRows()` — no mutable module state.
 *
 * @module cli/commands/interactive/bash-output-viewer
 */

import { palette } from '../../palette.js';
import type { PickerHost } from '../../render/picker.js';
import {
  type ViewerState,
  type ViewerLoadError,
  loadViewer,
  scrollUp,
  scrollDown,
  scrollHome,
  scrollEnd,
  applySearch,
  nextMatch,
  prevMatch,
  clearSearch,
  resize,
} from './bash-output-viewer-model.js';


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Rows consumed by the viewer chrome (header + footer) so the viewport height
 * excludes them. Must match the number of lines `buildChrome()` appends.
 */
const CHROME_ROWS = 3; // header line + separator + footer line

const SEARCH_PROMPT = '/';

// ---------------------------------------------------------------------------
// Chrome builders
// ---------------------------------------------------------------------------

function buildHeader(state: ViewerState, capturePath: string, searchMode: boolean, searchBuf: string): string {
  const total = state.totalLines.toLocaleString();
  const scrollPct = state.lines.length === 0
    ? '100%'
    : Math.round(((state.scrollTop + state.viewportRows) / state.lines.length) * 100) + '%';

  const pathDisplay = palette.dim(capturePath);
  const right = state.matchIndices.length > 0
    ? palette.info(` [${state.matchCursor + 1}/${state.matchIndices.length}]`)
    : '';
  const searchDisplay = searchMode
    ? palette.warning(` ${SEARCH_PROMPT}${searchBuf}█`)
    : state.searchQuery
    ? palette.dim(` /${state.searchQuery}`) + right
    : '';

  return (
    palette.bold('Bash output viewer') +
    palette.dim(` — ${total} lines  ${scrollPct}`) +
    searchDisplay +
    palette.dim('  ') +
    pathDisplay
  );
}

function buildFooter(searchMode: boolean): string {
  if (searchMode) {
    return palette.dim('Enter confirm · Esc cancel search');
  }
  return palette.dim('↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · /search · n/N match · q/Esc close');
}

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

/**
 * Return `line` with occurrences of `query` wrapped in the search-match style.
 * Case-insensitive. Returns `line` unchanged when query is empty or no match.
 */
function highlightMatches(line: string, query: string): string {
  if (query.trim() === '') return line;
  const lower = query.toLowerCase();
  let result = '';
  let i = 0;
  const lineLower = line.toLowerCase();
  while (i < line.length) {
    const hit = lineLower.indexOf(lower, i);
    if (hit < 0) { result += line.slice(i); break; }
    result += line.slice(i, hit) + palette.warning(line.slice(hit, hit + query.length));
    i = hit + query.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Render frame
// ---------------------------------------------------------------------------

function buildRows(
  state: ViewerState,
  capturePath: string,
  searchMode: boolean,
  searchBuf: string,
): readonly string[] {
  const rows: string[] = [];
  rows.push(buildHeader(state, capturePath, searchMode, searchBuf));
  rows.push(palette.dim('─'.repeat(40)));

  const end = Math.min(state.scrollTop + state.viewportRows, state.lines.length);
  for (let i = state.scrollTop; i < end; i++) {
    const rawLine = state.lines[i] ?? '';
    const isFocusedMatch =
      state.matchCursor >= 0 && state.matchIndices[state.matchCursor] === i;

    let rendered = state.searchQuery ? highlightMatches(rawLine, state.searchQuery) : rawLine;
    if (isFocusedMatch) {
      rendered = palette.bold(rendered);
    } else if (!state.searchQuery) {
      rendered = palette.dim(rendered);
    }
    rows.push(rendered);
  }

  if (state.lines.length === 0) {
    rows.push(palette.dim('  (empty output)'));
  }

  rows.push(buildFooter(searchMode));
  return rows;
}

// ---------------------------------------------------------------------------
// Error row
// ---------------------------------------------------------------------------

function errorRows(error: ViewerLoadError): readonly string[] {
  const msgs: Record<ViewerLoadError, string> = {
    missing:    'No capture file — output fit within the model cap (nothing was saved).',
    expired:    'Capture file no longer exists — it may have been removed by the witness sweep.',
    read_error: 'Could not read the capture file (permission or I/O error).',
  };
  return [
    palette.warning('⚠ Bash output viewer'),
    '',
    palette.dim('  ' + msgs[error]),
    '',
    palette.dim('  Press any key to close.'),
  ];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Open the bash output viewer in `host`.
 *
 * @param host          The compositor (or test double) that owns input routing.
 * @param capturePath   Absolute path to the capture file, or `undefined` when
 *                      the last bash tool call produced no capture.
 * @param signal        Abort signal (closed when the compositor disarms).
 * @returns             Promise that resolves when the viewer closes.
 */
export function runBashOutputViewer(
  host: PickerHost,
  capturePath: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }

    // ── Load ────────────────────────────────────────────────────────────────
    const termRows = host.terminalRows?.() ?? 24;
    const viewportRows = Math.max(1, termRows - CHROME_ROWS);
    const loadResult = loadViewer(capturePath, viewportRows);

    // If loading failed, show an error frame then close on any key.
    if (!loadResult.ok) {
      const errRows = errorRows(loadResult.error);
      let done = false;
      const onAbort = (): void => { if (!done) { done = true; host.exitPickerMode(); resolve(); } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      host.enterPickerMode({
        renderRows: () => errRows,
        onKey: () => { if (!done) { done = true; if (signal) signal.removeEventListener('abort', onAbort); host.exitPickerMode(); resolve(); } },
      });
      return;
    }

    // ── State ───────────────────────────────────────────────────────────────
    let state: ViewerState = loadResult.state;
    let searchMode = false;
    let searchBuf = '';
    let resolved = false;

    const close = (): void => {
      if (resolved) return;
      resolved = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      host.exitPickerMode();
      resolve();
    };

    const onAbort = (): void => close();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const effectivePath = capturePath ?? '';

    const renderRows = (): readonly string[] =>
      buildRows(state, effectivePath, searchMode, searchBuf);

    const onKey = (
      char: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
    ): void => {
      if (resolved) return;

      // ── Search-input mode ──────────────────────────────────────────────
      if (searchMode) {
        if (key.name === 'escape') {
          // Cancel search (discard buffer, restore prior query if any).
          searchMode = false;
          searchBuf = '';
          host.repaintPicker();
          return;
        }
        if (key.name === 'return') {
          // Confirm the typed query.
          state = applySearch(state, searchBuf);
          searchMode = false;
          // searchBuf kept so the header shows the active query.
          host.repaintPicker();
          return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
          searchBuf = searchBuf.slice(0, -1);
          host.repaintPicker();
          return;
        }
        if (char !== undefined && char.length === 1 && !key.ctrl && !key.meta) {
          const cp = char.codePointAt(0) ?? 0;
          if (cp >= 0x20) { searchBuf += char; host.repaintPicker(); return; }
        }
        return;
      }

      // ── Normal mode ────────────────────────────────────────────────────
      // Close unconditionally on q; Esc clears search first if active.
      if (char === 'q') {
        close();
        return;
      }
      if (key.name === 'escape') {
        if (state.searchQuery) {
          // First Esc clears search, second closes.
          state = clearSearch(state);
          host.repaintPicker();
          return;
        }
        close();
        return;
      }

      // Recalc viewport on each keypress in case terminal was resized.
      const currentRows = host.terminalRows?.() ?? 24;
      const vp = Math.max(1, currentRows - CHROME_ROWS);
      if (vp !== state.viewportRows) {
        state = resize(state, vp);
      }

      // Scroll.
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        state = scrollUp(state, 1); host.repaintPicker(); return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        state = scrollDown(state, 1); host.repaintPicker(); return;
      }
      if (key.name === 'pageup') {
        state = scrollUp(state, Math.max(1, state.viewportRows - 1)); host.repaintPicker(); return;
      }
      if (key.name === 'pagedown') {
        state = scrollDown(state, Math.max(1, state.viewportRows - 1)); host.repaintPicker(); return;
      }
      if (key.name === 'home' || char === 'g') {
        state = scrollHome(state); host.repaintPicker(); return;
      }
      if (key.name === 'end' || char === 'G') {
        state = scrollEnd(state); host.repaintPicker(); return;
      }

      // Search.
      if (char === '/') {
        searchMode = true;
        searchBuf = '';
        host.repaintPicker();
        return;
      }
      if (char === 'n') { state = nextMatch(state); host.repaintPicker(); return; }
      if (char === 'N') { state = prevMatch(state); host.repaintPicker(); return; }
    };

    host.enterPickerMode({ renderRows, onKey });
  });
}
