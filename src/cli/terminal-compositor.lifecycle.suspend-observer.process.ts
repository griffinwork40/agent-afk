/**
 * Chunk processing logic for the suspend write observer.
 *
 * Extracted from terminal-compositor.lifecycle.suspend-observer.ts to stay
 * within the 200-line function ceiling (the `processChunk` pipeline + its
 * helpers are >130 lines on their own). Takes explicit mutable state rather
 * than closing over installObserver locals so the helpers are fully testable
 * and statically analysable as top-level functions.
 *
 * All state lives on the {@link ObserverState} object that the caller allocates
 * and passes by reference; none of the functions here capture mutable closures.
 */

// Invariant (CSI buffer cap): sequences with a parameter section longer than
// CSI_BUF_MAX bytes are discarded. 64 bytes is well above any real cursor-move
// parameter and well below any DCS / passthrough payload.
export const CSI_BUF_MAX = 64;

/** All mutable cursor-tracking state owned by one observer installation. */
export interface ObserverState {
  row: number;
  col: number;
  scrolls: number;
  savedRow: number;
  savedCol: number;
  state: ObserverEscState;
  csiBuf: string;
}

// Contract: exported as a plain enum (not const enum) so the process module
// can be imported without re-exporting the EscState from the observer module
// and can be used in switch/if statements outside the original file boundary.
export const enum ObserverEscState {
  Normal = 0,
  Esc = 1,
  Csi = 2,
  AltScreen = 3,
}

/**
 * Parse a decimal integer from `buf` starting at `start`.
 * Returns [value, nextIndex]. Returns [def, start] when nothing was parsed.
 */
export function parseParam(buf: string, start: number, def: number): [number, number] {
  let i = start;
  let n = 0;
  let any = false;
  while (i < buf.length && buf[i]! >= '0' && buf[i]! <= '9') {
    n = n * 10 + (buf.charCodeAt(i) - 48);
    i++;
    any = true;
  }
  return any ? [n, i] : [def, start];
}

/**
 * Advance cursor row by 1 using the live terminal height. If row exceeds the
 * floor, scroll instead (row stays at the floor, scrolls increments).
 */
export function advanceRow(st: ObserverState, getRows: () => number): void {
  const rows = getRows();
  if (st.row < rows) {
    st.row++;
  } else {
    st.scrolls++;
  }
}

/**
 * Handle the completed CSI sequence (`st.csiBuf` set, final byte = `final`).
 * Mutates `st.row`, `st.col`, `st.scrolls`, `st.savedRow`, `st.savedCol`.
 * Returns true when the sequence triggers alt-screen ENTRY so the caller
 * can set state = AltScreen (avoids a const-enum narrowing error at the
 * CSI-branch call site where TypeScript sees state as always EscState.Csi).
 */
export function handleCsi(
  st: ObserverState,
  final: string,
  getRows: () => number,
  getCols: () => number,
): boolean {
  const cp = final.charCodeAt(0)!;
  const buf = st.csiBuf;

  // Alt-screen enter (caller sets state = AltScreen on true return).
  if (buf === '?1049' && final === 'h') return true;

  const rows = getRows();
  const cols = getCols();

  if (cp === 0x41) { // CUU — cursor up N
    const [n] = parseParam(buf, 0, 1);
    st.row = Math.max(1, st.row - n);
    return false;
  }
  if (cp === 0x42) { // CUD — cursor down N
    const [n] = parseParam(buf, 0, 1);
    st.row = Math.min(rows, st.row + n);
    return false;
  }
  if (cp === 0x45) { // CNL — cursor next line N
    const [n] = parseParam(buf, 0, 1);
    st.row = Math.min(rows, st.row + n);
    st.col = 0;
    return false;
  }
  if (cp === 0x46) { // CPL — cursor preceding line N
    const [n] = parseParam(buf, 0, 1);
    st.row = Math.max(1, st.row - n);
    st.col = 0;
    return false;
  }
  if (cp === 0x47 || cp === 0x60) { // CHA / ` — horizontal absolute
    const [n] = parseParam(buf, 0, 1);
    st.col = Math.max(0, Math.min(n - 1, cols - 1));
    return false;
  }
  // CUP (H) / HVP (f) — absolute row;col (1-based, default 1).
  // Contract: R is absolute terminal row; CUP uses absolute rows directly.
  if (cp === 0x48 || cp === 0x66) {
    let r1 = 1, c1 = 1;
    const [rv, ri] = parseParam(buf, 0, 1);
    r1 = rv;
    if (ri < buf.length && buf[ri] === ';') {
      const [cv] = parseParam(buf, ri + 1, 1);
      c1 = cv;
    }
    st.row = Math.max(1, Math.min(r1, rows));
    st.col = Math.max(0, Math.min(c1 - 1, cols - 1));
    return false;
  }
  if (cp === 0x64) { // VPA — vertical position absolute
    const [n] = parseParam(buf, 0, 1);
    st.row = Math.max(1, Math.min(n, rows));
    return false;
  }
  if (cp === 0x73 && buf === '') { // CSI s — save cursor
    st.savedRow = st.row;
    st.savedCol = st.col;
    return false;
  }
  if (cp === 0x75 && buf === '') { // CSI u — restore cursor
    st.row = st.savedRow;
    st.col = st.savedCol;
    return false;
  }
  return false; // all other CSI sequences: no-op
}

/**
 * Process one chunk of output written to the observed stream. Updates all
 * cursor-tracking state on `st` in place.
 */
export function processChunk(
  chunk: unknown,
  st: ObserverState,
  getRows: () => number,
  getCols: () => number,
): void {
  const s =
    typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString('utf8')
        : String(chunk);

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const cp = s.charCodeAt(i);

    if (st.state === ObserverEscState.AltScreen) {
      if (ch === '\x1b') {
        const rest = s.slice(i);
        if (rest.startsWith('\x1b[?1049l')) {
          st.state = ObserverEscState.Normal;
          i += '\x1b[?1049l'.length - 1;
        }
      }
      continue;
    }

    if (st.state === ObserverEscState.Esc) {
      if (ch === '[') {
        st.state = ObserverEscState.Csi;
        st.csiBuf = '';
      } else if (ch === '7') {
        st.savedRow = st.row; st.savedCol = st.col;
        st.state = ObserverEscState.Normal;
      } else if (ch === '8') {
        st.row = st.savedRow; st.col = st.savedCol;
        st.state = ObserverEscState.Normal;
      } else if (ch === 'M') {
        // ESC M — reverse index: cursor up 1, no scroll at top
        st.row = Math.max(1, st.row - 1);
        st.state = ObserverEscState.Normal;
      } else if (ch === 'D') {
        // ESC D — index (IND): like LF
        advanceRow(st, getRows);
        st.state = ObserverEscState.Normal;
      } else if (ch === 'E') {
        // ESC E — next line (NEL): like LF + CR
        advanceRow(st, getRows);
        st.col = 0;
        st.state = ObserverEscState.Normal;
      } else {
        st.state = ObserverEscState.Normal;
      }
      continue;
    }

    if (st.state === ObserverEscState.Csi) {
      if (st.csiBuf.length >= CSI_BUF_MAX) {
        // Invariant (CSI overflow discard): the parameter section exceeded
        // CSI_BUF_MAX bytes — the sequence is malformed or intentionally
        // oversized (fuzzing, DCS passthrough). We cannot trust any byte as
        // a final-byte boundary yet; enter a discard loop that swallows all
        // remaining bytes until the CSI final byte (0x40–0x7E), then returns
        // to Normal. Re-processing the current byte as Normal (the old i--
        // approach) is wrong: parameter bytes (0x30–0x3F) are NOT printable
        // and would silently corrupt `col` via the printable branch below.
        while (i < s.length) {
          const discardCp = s.charCodeAt(i);
          i++;
          if (discardCp >= 0x40 && discardCp <= 0x7e) break; // final byte consumed
        }
        i--; // outer loop will i++ again
        st.csiBuf = '';
        st.state = ObserverEscState.Normal;
        continue;
      }
      if (cp >= 0x40 && cp <= 0x7e) {
        // Final byte: dispatch and conditionally enter alt-screen.
        const enteredAltScreen = handleCsi(st, ch, getRows, getCols);
        st.state = enteredAltScreen ? ObserverEscState.AltScreen : ObserverEscState.Normal;
        st.csiBuf = '';
      } else {
        st.csiBuf += ch;
      }
      continue;
    }

    // ObserverEscState.Normal
    if (ch === '\x1b') { st.state = ObserverEscState.Esc; continue; }
    if (ch === '\r') { st.col = 0; continue; }
    if (ch === '\n') { st.col = 0; advanceRow(st, getRows); continue; }
    if (cp < 0x20 || cp === 0x7f) continue; // other control chars

    // Printable: advance column, soft-wrap if needed.
    st.col++;
    const cols = getCols();
    if (cols > 0 && st.col >= cols) {
      st.col = 0;
      advanceRow(st, getRows);
    }
  }
}
