/**
 * Pure state model for the in-TUI bash output viewer.
 *
 * Owns scroll position, search state, and the loaded lines array — all
 * mutation is through the exported action functions so the model is
 * unit-testable without touching the terminal.
 *
 * Constraints honoured here (AFK.md §conventions):
 *   - No chalk / palette import — this is a pure data layer.
 *   - stripEscapeSequences from src/utils/terminal-sanitize is applied once
 *     on load, never per-render.
 *   - Large files are bounded: at most VIEWER_MAX_LINES lines are held in
 *     memory; the remainder is silently elided with a notice appended to lines.
 *   - Missing / retention-expired capture files surface as an explicit
 *     ViewerLoadError rather than a crash.
 *
 * @module cli/commands/interactive/bash-output-viewer-model
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { getWitnessRoot } from '../../../paths.witness.js';

// ---------------------------------------------------------------------------
// Confinement root (test-overridable)
// ---------------------------------------------------------------------------

/**
 * The directory prefix that `capturePath` must start with. Defaults to the
 * witness root so all capture files live under the AFK state tree.
 *
 * Tests may override this via `_setConfinementRootForTest(dir)` to redirect
 * the confinement check to a throwaway temp directory — never use in
 * production code.
 *
 * @internal
 */
let _confinementRoot: string | null = null;

/** @internal — for unit tests only. */
export function _setConfinementRootForTest(root: string | null): void {
  _confinementRoot = root;
}

function getConfinementRoot(): string {
  return _confinementRoot ?? getWitnessRoot();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum lines loaded into the viewer.  8 MB / ~80 bytes ≈ 100 K lines; cap
 * here to 20 K so rendering stays fast and memory stays bounded.
 */
export const VIEWER_MAX_LINES = 20_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ViewerState {
  /** Sanitized, line-split content (bounded to VIEWER_MAX_LINES). */
  lines: readonly string[];
  /** True when the file exceeded VIEWER_MAX_LINES and was truncated. */
  truncated: boolean;
  /** Total line count BEFORE truncation (0 when file was empty). */
  totalLines: number;
  /** First visible line index (0-based). */
  scrollTop: number;
  /** Number of terminal rows available for content (viewport height). */
  viewportRows: number;
  /** Current search query (empty string = no search). */
  searchQuery: string;
  /** 0-based indices of lines that match the current search query. */
  matchIndices: readonly number[];
  /** Which match is focused (index into matchIndices). -1 = none. */
  matchCursor: number;
}

// ---------------------------------------------------------------------------
// Load result
// ---------------------------------------------------------------------------

export type ViewerLoadResult =
  | { ok: true; state: ViewerState }
  | { ok: false; error: ViewerLoadError };

export type ViewerLoadError =
  | 'missing'       // file not found (path undefined or ENOENT)
  | 'expired'       // ENOENT after retention sweep (synonym, same UX)
  | 'read_error';   // other I/O error

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Load a capture file into a fresh ViewerState.
 *
 * Always sanitizes terminal escapes via `stripEscapeSequences` — the content
 * originates from arbitrary subprocess output and MUST NOT reach the terminal
 * un-sanitized.
 */
export function loadViewer(capturePath: string | undefined, viewportRows: number): ViewerLoadResult {
  if (capturePath === undefined) {
    return { ok: false, error: 'missing' };
  }
  // Path confinement: reject any path that escapes the witness state dir so a
  // malicious or buggy capturePath cannot read arbitrary files on disk.
  const resolved = path.resolve(capturePath);
  const confinementRoot = getConfinementRoot();
  if (!resolved.startsWith(confinementRoot + path.sep) && resolved !== confinementRoot) {
    return { ok: false, error: 'read_error' };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { ok: false, error: 'expired' };
    return { ok: false, error: 'read_error' };
  }

  // Sanitize: strip ANSI/CSI/OSC/DCS escape sequences; keep newlines so line
  // structure is preserved.  stripEscapeSequences is the correct function here
  // (not sanitizeForDisplay, which also collapses all control bytes to spaces
  // and trims, destroying multi-line structure).
  const sanitized = stripEscapeSequences(raw);

  const rawLines = sanitized.split('\n');
  // Drop a trailing empty string created by a trailing newline — the file
  // conventionally ends with '\n' but that should not produce a phantom last line.
  const allLines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const totalLines = allLines.length;
  const truncated = totalLines > VIEWER_MAX_LINES;
  const lines: string[] = truncated ? allLines.slice(0, VIEWER_MAX_LINES) : allLines;
  if (truncated) {
    lines.push(
      `[… ${totalLines - VIEWER_MAX_LINES} lines elided — file exceeded viewer limit (${VIEWER_MAX_LINES} lines)]`,
    );
  }

  // Start at the end (tail-first, matching the default compact outcome view).
  const safeViewport = Math.max(1, viewportRows);
  const scrollTop = Math.max(0, lines.length - safeViewport);

  return {
    ok: true,
    state: {
      lines,
      truncated,
      totalLines,
      scrollTop,
      viewportRows: safeViewport,
      searchQuery: '',
      matchIndices: [],
      matchCursor: -1,
    },
  };
}

// ---------------------------------------------------------------------------
// Scroll helpers
// ---------------------------------------------------------------------------

/** Maximum valid scrollTop for the current lines + viewport. */
export function maxScrollTop(state: ViewerState): number {
  return Math.max(0, state.lines.length - state.viewportRows);
}

/** Return state scrolled up by `delta` lines, clamped to [0, maxScrollTop]. */
export function scrollUp(state: ViewerState, delta: number): ViewerState {
  const next = Math.max(0, state.scrollTop - delta);
  return { ...state, scrollTop: next };
}

/** Return state scrolled down by `delta` lines, clamped to [0, maxScrollTop]. */
export function scrollDown(state: ViewerState, delta: number): ViewerState {
  const next = Math.min(maxScrollTop(state), state.scrollTop + delta);
  return { ...state, scrollTop: next };
}

/** Jump to the very first line. */
export function scrollHome(state: ViewerState): ViewerState {
  return { ...state, scrollTop: 0 };
}

/** Jump to the last screenful. */
export function scrollEnd(state: ViewerState): ViewerState {
  return { ...state, scrollTop: maxScrollTop(state) };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Build a new match index for `query`.  Case-insensitive substring search.
 * Returns an empty array when query is empty or blank.
 */
function buildMatchIndices(lines: readonly string[], query: string): readonly number[] {
  if (query.trim() === '') return [];
  const lower = query.toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.toLowerCase().includes(lower)) hits.push(i);
  }
  return hits;
}

/** Apply a new search query and reset matchCursor to the first match at or after scrollTop. */
export function applySearch(state: ViewerState, query: string): ViewerState {
  const matchIndices = buildMatchIndices(state.lines, query);
  // Focus the first match that is visible or below the current scrollTop.
  let matchCursor = matchIndices.length > 0 ? 0 : -1;
  if (matchIndices.length > 0) {
    const first = matchIndices.findIndex((i) => i >= state.scrollTop);
    matchCursor = first >= 0 ? first : 0;
  }
  const scrollTop = matchCursor >= 0 && matchIndices[matchCursor] !== undefined
    ? scrollToLine(state, matchIndices[matchCursor]!).scrollTop
    : state.scrollTop;
  return { ...state, searchQuery: query, matchIndices, matchCursor, scrollTop };
}

/** Scroll so `lineIndex` is visible — place it near the top of the viewport. */
function scrollToLine(state: ViewerState, lineIndex: number): ViewerState {
  const preferred = Math.max(0, lineIndex - Math.floor(state.viewportRows / 4));
  const scrollTop = Math.min(preferred, maxScrollTop(state));
  return { ...state, scrollTop };
}

/** Move to the next search match. Wraps. */
export function nextMatch(state: ViewerState): ViewerState {
  if (state.matchIndices.length === 0) return state;
  const cursor = (state.matchCursor + 1) % state.matchIndices.length;
  const lineIdx = state.matchIndices[cursor];
  if (lineIdx === undefined) return state;
  return { ...scrollToLine(state, lineIdx), matchCursor: cursor };
}

/** Move to the previous search match. Wraps. */
export function prevMatch(state: ViewerState): ViewerState {
  if (state.matchIndices.length === 0) return state;
  const cursor = (state.matchCursor - 1 + state.matchIndices.length) % state.matchIndices.length;
  const lineIdx = state.matchIndices[cursor];
  if (lineIdx === undefined) return state;
  return { ...scrollToLine(state, lineIdx), matchCursor: cursor };
}

/** Clear the search query. */
export function clearSearch(state: ViewerState): ViewerState {
  return { ...state, searchQuery: '', matchIndices: [], matchCursor: -1 };
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

/** Update viewport height (e.g. terminal resize). Clamps scrollTop. */
export function resize(state: ViewerState, viewportRows: number): ViewerState {
  const safe = Math.max(1, viewportRows);
  const scrollTop = Math.min(state.scrollTop, Math.max(0, state.lines.length - safe));
  return { ...state, viewportRows: safe, scrollTop };
}
