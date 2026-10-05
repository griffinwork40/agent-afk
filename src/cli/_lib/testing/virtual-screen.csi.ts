/**
 * CSI (Control Sequence Introducer) dispatch and erase operations for
 * VirtualScreen -- extracted from virtual-screen.ts.
 *
 * Exports: dispatchCsi, normalizeCsiParams, eraseCursorToEndOfLine,
 * eraseStartOfLineToCursor, eraseEntireLine, eraseCursorToEndOfScreen,
 * eraseStartOfScreenToCursor, eraseEntireScreen.
 *
 * All functions receive explicit grid/cursor parameters so they carry no
 * module-scope state. VirtualScreen passes its fields by reference and
 * reassigns mutated values back as needed.
 */

/**
 * Mutable cursor + grid state the CSI and erase helpers read and write.
 * VirtualScreen passes the relevant slices of its own private fields;
 * the helpers mutate in place (grid, scrollback arrays) or return the
 * new scalar value that the caller must write back.
 */
export interface CsiHost {
  /** Number of columns. */
  readonly cols: number;
  /** Number of rows. */
  readonly rows: number;
  /** 2D character grid (1-indexed rows, 0-indexed arrays). Mutated in place. */
  readonly grid: string[][];
  /** Current cursor row (1-based). Callers read back via the return values where needed. */
  cursorRow: number;
  /** Current cursor column (1-based). */
  cursorCol: number;
  /** Pending-wrap flag -- set when the cursor hits the last column. */
  pendingWrap: boolean;
  /** Top row of the scroll region (1-based, inclusive). */
  scrollTop: number;
  /** Bottom row of the scroll region (1-based, inclusive). */
  scrollBottom: number;
  /** Whether the cursor is hidden. */
  cursorHidden: boolean;
  /** Accumulated OSC sequences. */
  readonly oscSequences: string[];
  /** Scrollback lines (appended on scroll-up). */
  scrollback: string[];
  /** Clamp a row value to [1, rows]. */
  clampRow(r: number): number;
  /** Clamp a column value to [1, cols]. */
  clampCol(c: number): number;
  /** Return the right-trimmed text of row `row` (1-based). */
  lineAt(row: number): string;
  /** Scroll the scroll region up one line. */
  scrollRegionUp(): void;
}

// ---------------------------------------------------------------------------
// CSI parameter normalization
// ---------------------------------------------------------------------------

/**
 * Normalize the raw CSI parameter accumulator (where -1 is a separator
 * marker and real digits are positive integers) into a plain number array.
 * Trailing separator markers are stripped so `CSI H` (no params) maps to
 * `[]` and `CSI 5 H` maps to `[5]`.
 */
export function normalizeCsiParams(raw: number[]): number[] {
  const params: number[] = [];
  for (const val of raw) {
    if (val === -1) {
      params.push(0);
    } else {
      params.push(val);
    }
  }
  const lastRaw = raw[raw.length - 1];
  while (params.length > 0 && params[params.length - 1] === 0 && lastRaw === -1) {
    params.pop();
  }
  return params;
}

// ---------------------------------------------------------------------------
// Erase helpers
// ---------------------------------------------------------------------------

export function eraseCursorToEndOfLine(host: CsiHost): void {
  const row = host.cursorRow - 1;
  if (row >= 0 && row < host.rows) {
    for (let c = host.cursorCol - 1; c < host.cols; c++) {
      host.grid[row]![c] = ' ';
    }
  }
}

export function eraseStartOfLineToCursor(host: CsiHost): void {
  const row = host.cursorRow - 1;
  if (row >= 0 && row < host.rows) {
    for (let c = 0; c < host.cursorCol; c++) {
      host.grid[row]![c] = ' ';
    }
  }
}

export function eraseEntireLine(host: CsiHost): void {
  const row = host.cursorRow - 1;
  if (row >= 0 && row < host.rows) {
    for (let c = 0; c < host.cols; c++) {
      host.grid[row]![c] = ' ';
    }
  }
}

export function eraseCursorToEndOfScreen(host: CsiHost): void {
  // Erase from cursor to end of line (on current row).
  eraseCursorToEndOfLine(host);
  // Erase all lines below cursor.
  for (let r = host.cursorRow + 1; r <= host.rows; r++) {
    const savedRow = host.cursorRow;
    host.cursorRow = r;
    eraseEntireLine(host);
    host.cursorRow = savedRow;
  }
}

export function eraseStartOfScreenToCursor(host: CsiHost): void {
  // Erase all lines above cursor.
  for (let r = 1; r < host.cursorRow; r++) {
    const oldRow = host.cursorRow;
    host.cursorRow = r;
    eraseEntireLine(host);
    host.cursorRow = oldRow;
  }
  // Erase from start of line to cursor.
  eraseStartOfLineToCursor(host);
}

export function eraseEntireScreen(host: CsiHost): void {
  for (let r = 0; r < host.rows; r++) {
    for (let c = 0; c < host.cols; c++) {
      host.grid[r]![c] = ' ';
    }
  }
}

// ---------------------------------------------------------------------------
// CSI dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a single CSI sequence to `host`. The `final` byte is the
 * sequence terminator (0x40-0x7E); `rawParams` is the raw accumulator
 * and `privatePrefix` is true when a `?` was seen before the parameters.
 *
 * Invariant: this function directly mutates `host.cursorRow`,
 * `host.cursorCol`, `host.pendingWrap`, `host.scrollTop`,
 * `host.scrollBottom`, `host.cursorHidden`, and `host.scrollback`.
 * Callers must NOT cache those fields before calling this function.
 */
export function dispatchCsi(
  host: CsiHost,
  final: number,
  rawParams: number[],
  privatePrefix: boolean,
): void {
  const params = normalizeCsiParams(rawParams);
  const finalChar = String.fromCharCode(final);

  if (finalChar === 'H' || finalChar === 'f') {
    // CUP -- Cursor Position: param0=row (1-based), param1=col (1-based)
    const row = params[0] !== undefined ? params[0] : 1;
    const col = params[1] !== undefined ? params[1] : 1;
    host.cursorRow = host.clampRow(row);
    host.cursorCol = host.clampCol(col);
    host.pendingWrap = false;
  } else if (finalChar === 'A') {
    // CUU -- Cursor Up by param0 rows
    const count = params[0] !== undefined ? params[0] : 1;
    host.cursorRow = host.clampRow(host.cursorRow - count);
  } else if (finalChar === 'B') {
    // CUD -- Cursor Down by param0 rows
    const count = params[0] !== undefined ? params[0] : 1;
    host.cursorRow = host.clampRow(host.cursorRow + count);
  } else if (finalChar === 'C') {
    // CUF -- Cursor Forward by param0 cols
    const count = params[0] !== undefined ? params[0] : 1;
    host.cursorCol = host.clampCol(host.cursorCol + count);
  } else if (finalChar === 'D') {
    // CUB -- Cursor Back by param0 cols
    const count = params[0] !== undefined ? params[0] : 1;
    host.cursorCol = host.clampCol(host.cursorCol - count);
  } else if (finalChar === 'G') {
    // CHA -- Cursor Horizontal Absolute
    const col = params[0] !== undefined ? params[0] : 1;
    host.cursorCol = host.clampCol(col);
  } else if (finalChar === 'd') {
    // VPA -- Cursor Vertical Absolute
    const row = params[0] !== undefined ? params[0] : 1;
    host.cursorRow = host.clampRow(row);
  } else if (finalChar === 'J') {
    // ED -- Erase in Display
    const mode = params[0] !== undefined ? params[0] : 0;
    if (mode === 0 || params.length === 0) {
      eraseCursorToEndOfScreen(host);
    } else if (mode === 1) {
      eraseStartOfScreenToCursor(host);
    } else if (mode === 2) {
      eraseEntireScreen(host);
    } else if (mode === 3) {
      // Erase entire screen and scrollback (xterm extension)
      eraseEntireScreen(host);
      host.scrollback = [];
    }
  } else if (finalChar === 'K') {
    // EL -- Erase in Line
    const mode = params[0] !== undefined ? params[0] : 0;
    if (mode === 0 || params.length === 0) {
      eraseCursorToEndOfLine(host);
    } else if (mode === 1) {
      eraseStartOfLineToCursor(host);
    } else if (mode === 2) {
      eraseEntireLine(host);
    }
  } else if (finalChar === 'm') {
    // SGR -- Select Graphic Rendition (no-op for content assertions)
  } else if (finalChar === 'r' && !privatePrefix) {
    // DECSTBM -- Set scrolling region
    const top = params[0] !== undefined ? params[0] : 1;
    const bottom = params[1] !== undefined ? params[1] : host.rows;
    if (top < bottom) {
      host.scrollTop = host.clampRow(top);
      host.scrollBottom = host.clampRow(bottom);
    }
  } else if (privatePrefix && (finalChar === 'h' || finalChar === 'l')) {
    // DECSET/DECRST -- Private mode set/reset
    const code = params[0];
    if (code === 25) {
      // Cursor visibility: 'h' = show, 'l' = hide
      host.cursorHidden = finalChar === 'l';
    }
    // 2026 (sync mode) and others are no-ops for testing
  }
}
