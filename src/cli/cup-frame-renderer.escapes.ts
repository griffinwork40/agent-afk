/**
 * cup-frame-renderer.escapes.ts
 *
 * Pure escape-sequence constants and builder functions for CUP-based frame
 * rendering. All exports are side-effect-free string producers — no state,
 * no I/O.
 */

// ---------------------------------------------------------------------------
// Synchronized output — supported by xterm/iTerm2/Apple Terminal. Wrapping a
// frame write in these escapes prevents visible tearing when rendering multiple
// lines in a single operation.
// ---------------------------------------------------------------------------
export const SYNC_START = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

// ---------------------------------------------------------------------------
// CUP: absolute cursor position. Rows and columns are 1-based.
// ---------------------------------------------------------------------------
/** Build a CUP (Cursor Position) escape to move the cursor to (row, col). */
export const cup = (row: number, col: number): string => `\x1b[${row};${col}H`;

// ---------------------------------------------------------------------------
// Erase: clear an entire line without moving the cursor.
// ---------------------------------------------------------------------------
/** Erase entire line at the current cursor position (cursor does not move). */
export const ERASE_LINE = '\x1b[2K';

// ---------------------------------------------------------------------------
// Cursor visibility — avoids a direct dep on cli-cursor (which is only a
// transitive dep under log-update and not directly accessible under pnpm's
// strict hoisting). The escape codes are stable VT100/xterm sequences.
// ---------------------------------------------------------------------------
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
