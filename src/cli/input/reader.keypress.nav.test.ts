/**
 * Unit tests for `src/cli/input/reader.keypress.nav.ts` (COV-009).
 *
 * Strategy: handleNavKey and writeEofOutput are pure functions of their
 * arguments. We construct minimal ReaderState and RepaintCtx objects by
 * hand (no real TTY, no ansi-escapes side effects on a live terminal) and
 * verify:
 *   - the correct InputCore mutation was applied to st.input
 *   - repaintFn was (or was not) called
 *   - history methods were (or were not) invoked
 *   - the correct boolean was returned
 *
 * ansi-escapes is mocked so stdout.write calls can be inspected without
 * a real terminal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any SUT import.
// ---------------------------------------------------------------------------

vi.mock('ansi-escapes', () => ({
  cursorUp: (n: number) => `\x1b[${n}A`,
  eraseDown: '\x1b[J',
}));

// SUT imported after mocks.
import { handleNavKey, writeEofOutput } from './reader.keypress.nav.js';
import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint } from './reader.repaint.js';
import type { KeyInfo, IHistoryRing } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReaderState with the given buffer at the given cursor. */
function makeState(buffer = '', cursor = 0): ReaderState {
  return {
    input: { buffer, cursor: Math.min(cursor, buffer.length) },
    ac: {
      dropdownOpen: false,
      candidates: [],
      selectedIndex: 0,
      viewportStart: 0,
      suppressedSignature: null,
      trigger: null,
      reset: vi.fn(),
    },
    rowsBelow: 0,
    pasting: false,
    clipboardInFlight: false,
    pasteStartBufferLen: 0,
    prevBufferRows: 0,
    prevStatusRows: 0,
    clipboardFailureMsg: null,
    attachments: [],
    maxDropdownRows: 6,
    lastKeypressAt: 0,
    repaintPending: false,
    settled: false,
    reverseSearch: {
      active: false,
      query: '',
      matchIndex: -1,
      savedBuffer: '',
    } as ReaderState['reverseSearch'],
  };
}

/** Build a minimal RepaintCtx. */
function makeCtx(cols = 80): RepaintCtx {
  return {
    stdout: { columns: cols } as NodeJS.WriteStream,
    promptText: '> ',
    promptVisibleLen: 2,
    slashRegistryView: { has: () => false },
    historyGetEntries: undefined,
  };
}

/** Build a minimal IHistoryRing. */
function makeHistory(
  backResult: string | null = null,
  forwardResult: string | null = null,
): IHistoryRing {
  return {
    back: vi.fn().mockReturnValue(backResult),
    forward: vi.fn().mockReturnValue(forwardResult),
    resetRecall: vi.fn(),
    get inRecall() { return false; },
  };
}

/** Build a KeyInfo object. */
function key(
  name: string,
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): KeyInfo {
  return { name, ctrl: false, meta: false, shift: false, sequence: name, ...opts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let repaintFn: typeof repaint;
let ctx: RepaintCtx;

beforeEach(() => {
  repaintFn = vi.fn() as unknown as typeof repaint;
  ctx = makeCtx();
});

// ─── Ctrl+L ────────────────────────────────────────────────────────────────

describe('Ctrl+L — clear screen', () => {
  it('returns true and calls repaintFn', () => {
    const st = makeState('hello', 3);
    const writes: string[] = [];
    const stdout = { ...ctx.stdout, write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const localCtx = { ...ctx, stdout };
    const handled = handleNavKey(key('l', { ctrl: true }), st, stdout, localCtx, repaintFn, undefined);
    expect(handled).toBe(true);
    expect(repaintFn).toHaveBeenCalledOnce();
    expect(writes.join('')).toContain('\x1b[H\x1b[2J');
  });

  it('resets prevBufferRows and prevStatusRows before repaint', () => {
    const st = makeState('text', 2);
    st.prevBufferRows = 3;
    st.prevStatusRows = 1;
    const stdout = { write: vi.fn().mockReturnValue(true), columns: 80 } as unknown as NodeJS.WriteStream;
    handleNavKey(key('l', { ctrl: true }), st, stdout, ctx, repaintFn, undefined);
    expect(st.prevBufferRows).toBe(0);
    expect(st.prevStatusRows).toBe(0);
  });
});

// ─── Ctrl+A / Ctrl+E ───────────────────────────────────────────────────────

describe('Ctrl+A — move to line start', () => {
  it('moves cursor to start and calls repaintFn', () => {
    const st = makeState('hello', 5);
    handleNavKey(key('a', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('returns true even when cursor is already at start', () => {
    const st = makeState('hello', 0);
    const handled = handleNavKey(key('a', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(handled).toBe(true);
    // no repaint if state unchanged
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

describe('Ctrl+E — move to line end', () => {
  it('moves cursor to end of line', () => {
    const st = makeState('hello world', 0);
    handleNavKey(key('e', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(11);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

// ─── Ctrl+B / Ctrl+F ───────────────────────────────────────────────────────

describe('Ctrl+B — char backward', () => {
  it('moves cursor left by one', () => {
    const st = makeState('hello', 3);
    handleNavKey(key('b', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(2);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does not move when at position 0', () => {
    const st = makeState('hello', 0);
    handleNavKey(key('b', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(0);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

describe('Ctrl+F — char forward', () => {
  it('moves cursor right by one', () => {
    const st = makeState('hello', 2);
    handleNavKey(key('f', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(3);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

// ─── Alt+B / Alt+F ─────────────────────────────────────────────────────────

describe('Alt+B — word backward', () => {
  it('moves cursor to start of previous word', () => {
    const st = makeState('hello world', 11);
    handleNavKey(key('b', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBeLessThan(11);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

describe('Alt+F — word forward', () => {
  it('moves cursor to end of next word', () => {
    const st = makeState('hello world', 0);
    handleNavKey(key('f', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBeGreaterThan(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

// ─── Ctrl+W ────────────────────────────────────────────────────────────────

describe('Ctrl+W — delete word backward', () => {
  it('deletes the word before cursor', () => {
    const st = makeState('hello world', 11);
    const hist = makeHistory();
    handleNavKey(key('w', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe('hello ');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('is a no-op when buffer is empty', () => {
    const st = makeState('', 0);
    handleNavKey(key('w', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Arrow up / Ctrl+P ─────────────────────────────────────────────────────

describe('Ctrl+P / ↑ — up / history back', () => {
  it('navigates dropdown selection up when dropdown is open', () => {
    const st = makeState('/', 1);
    st.ac.dropdownOpen = true;
    st.ac.candidates = [{ value: 'a' }, { value: 'b' }];
    st.ac.selectedIndex = 1;
    st.ac.viewportStart = 0;
    handleNavKey(key('up'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.selectedIndex).toBe(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does nothing when dropdown is open and selectedIndex is already 0', () => {
    const st = makeState('/', 1);
    st.ac.dropdownOpen = true;
    st.ac.candidates = [{ value: 'a' }];
    st.ac.selectedIndex = 0;
    handleNavKey(key('up'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.selectedIndex).toBe(0);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('recalls history when buffer is single line and at top', () => {
    const st = makeState('', 0);
    const hist = makeHistory('prev-entry');
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    handleNavKey(key('p', { ctrl: true }), st, stdout, ctx, repaintFn, hist);
    expect(hist.back).toHaveBeenCalled();
    expect(st.input.buffer).toBe('prev-entry');
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does not recall when history.back returns null', () => {
    const st = makeState('', 0);
    const hist = makeHistory(null);
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    handleNavKey(key('up'), st, stdout, ctx, repaintFn, hist);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('adjusts viewportStart when selectedIndex < viewportStart', () => {
    const st = makeState('/', 1);
    st.ac.dropdownOpen = true;
    st.ac.candidates = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];
    st.ac.selectedIndex = 1;
    st.ac.viewportStart = 1; // selectedIndex will drop to 0 < viewportStart
    handleNavKey(key('up'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.viewportStart).toBe(0);
  });
});

// ─── Arrow down / Ctrl+N ───────────────────────────────────────────────────

describe('Ctrl+N / ↓ — down / history forward', () => {
  it('navigates dropdown selection down when dropdown is open', () => {
    const st = makeState('/', 1);
    st.ac.dropdownOpen = true;
    st.ac.candidates = [{ value: 'a' }, { value: 'b' }];
    st.ac.selectedIndex = 0;
    st.maxDropdownRows = 6;
    handleNavKey(key('down'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.selectedIndex).toBe(1);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does nothing when at last candidate', () => {
    const st = makeState('/', 1);
    st.ac.dropdownOpen = true;
    st.ac.candidates = [{ value: 'a' }];
    st.ac.selectedIndex = 0;
    handleNavKey(key('down'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.selectedIndex).toBe(0);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('navigates history forward when no dropdown', () => {
    const st = makeState('', 0);
    const hist = makeHistory(null, 'next-entry');
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    handleNavKey(key('n', { ctrl: true }), st, stdout, ctx, repaintFn, hist);
    expect(hist.forward).toHaveBeenCalled();
    expect(st.input.buffer).toBe('next-entry');
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does not recall when history.forward returns null', () => {
    const st = makeState('', 0);
    const hist = makeHistory(null, null);
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    handleNavKey(key('down'), st, stdout, ctx, repaintFn, hist);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('advances viewportStart when selectedIndex exceeds viewport bottom', () => {
    const st = makeState('/', 1);
    st.maxDropdownRows = 2;
    st.ac.dropdownOpen = true;
    st.ac.candidates = [
      { value: 'a' },
      { value: 'b' },
      { value: 'c' },
    ];
    st.ac.selectedIndex = 1; // will become 2, which is >= viewportStart(0) + maxDropdownRows(2)
    st.ac.viewportStart = 0;
    handleNavKey(key('down'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.ac.viewportStart).toBe(1);
  });
});

// ─── Left / Right arrow ────────────────────────────────────────────────────

describe('left arrow', () => {
  it('moves cursor left', () => {
    const st = makeState('abc', 2);
    handleNavKey(key('left'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(1);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('does not move when at start', () => {
    const st = makeState('abc', 0);
    handleNavKey(key('left'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

describe('right arrow', () => {
  it('moves cursor right', () => {
    const st = makeState('abc', 1);
    handleNavKey(key('right'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(2);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

// ─── Home / End ────────────────────────────────────────────────────────────

describe('home key', () => {
  it('moves to buffer start', () => {
    const st = makeState('hello world', 7);
    handleNavKey(key('home'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

describe('end key', () => {
  it('moves to buffer end', () => {
    const st = makeState('hello world', 0);
    handleNavKey(key('end'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.input.cursor).toBe(11);
    expect(repaintFn).toHaveBeenCalledOnce();
  });
});

// ─── Ctrl+U ────────────────────────────────────────────────────────────────

describe('Ctrl+U — delete to line start', () => {
  it('deletes everything before cursor', () => {
    const st = makeState('hello world', 5);
    const hist = makeHistory();
    handleNavKey(key('u', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe(' world');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('is a no-op at position 0', () => {
    const st = makeState('hello', 0);
    handleNavKey(key('u', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Ctrl+K ────────────────────────────────────────────────────────────────

describe('Ctrl+K — delete to line end', () => {
  it('deletes everything after cursor', () => {
    const st = makeState('hello world', 5);
    const hist = makeHistory();
    handleNavKey(key('k', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe('hello');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('is a no-op at buffer end', () => {
    const st = makeState('hello', 5);
    handleNavKey(key('k', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Ctrl+X ────────────────────────────────────────────────────────────────

describe('Ctrl+X — discard last attachment', () => {
  it('pops the last attachment when one exists', () => {
    const st = makeState('');
    st.attachments = [{ id: 'img1', mediaType: 'image/png' as const, bytes: Buffer.alloc(1), sizeBytes: 1 }];
    handleNavKey(key('x', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.attachments).toHaveLength(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('returns true even when no attachments', () => {
    const st = makeState('');
    const handled = handleNavKey(key('x', { ctrl: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(handled).toBe(true);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Backspace ─────────────────────────────────────────────────────────────

describe('backspace', () => {
  it('deletes the previous character', () => {
    const st = makeState('hello', 5);
    const hist = makeHistory();
    handleNavKey(key('backspace'), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe('hell');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('pops attachment when buffer is empty and attachment exists', () => {
    const st = makeState('', 0);
    st.attachments = [{ id: 'img1', mediaType: 'image/png' as const, bytes: Buffer.alloc(1), sizeBytes: 1 }];
    handleNavKey(key('backspace'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(st.attachments).toHaveLength(0);
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('meta+backspace deletes the previous word', () => {
    const st = makeState('hello world', 11);
    const hist = makeHistory();
    handleNavKey(key('backspace', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe('hello ');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('meta+backspace no-op when buffer empty', () => {
    const st = makeState('', 0);
    handleNavKey(key('backspace', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Delete ────────────────────────────────────────────────────────────────

describe('delete key', () => {
  it('deletes the character under the cursor', () => {
    const st = makeState('hello', 2);
    const hist = makeHistory();
    handleNavKey(key('delete'), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe('helo');
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('is a no-op when cursor is at end', () => {
    const st = makeState('hello', 5);
    handleNavKey(key('delete'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('meta+delete deletes the next word', () => {
    const st = makeState('hello world', 0);
    const hist = makeHistory();
    handleNavKey(key('delete', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, hist);
    expect(st.input.buffer).toBe(' world'); // "hello" deleted
    expect(hist.resetRecall).toHaveBeenCalledOnce();
    expect(repaintFn).toHaveBeenCalledOnce();
  });

  it('meta+delete no-op when cursor at end', () => {
    const st = makeState('hello', 5);
    handleNavKey(key('delete', { meta: true }), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(repaintFn).not.toHaveBeenCalled();
  });
});

// ─── Unrecognised key ──────────────────────────────────────────────────────

describe('unrecognised key', () => {
  it('returns false for a plain printable character key', () => {
    const st = makeState('', 0);
    const handled = handleNavKey(key('z'), st, {} as NodeJS.WriteStream, ctx, repaintFn, undefined);
    expect(handled).toBe(false);
    expect(repaintFn).not.toHaveBeenCalled();
  });

  it('returns false for an undefined key name', () => {
    const st = makeState('', 0);
    const handled = handleNavKey(
      { name: undefined, ctrl: false, meta: false, shift: false, sequence: '' } as unknown as KeyInfo,
      st,
      {} as NodeJS.WriteStream,
      ctx,
      repaintFn,
      undefined,
    );
    expect(handled).toBe(false);
  });
});

// ─── writeEofOutput ────────────────────────────────────────────────────────

describe('writeEofOutput', () => {
  it('writes a newline when no previous rows', () => {
    const st = makeState('');
    st.prevBufferRows = 0;
    st.prevStatusRows = 0;
    st.rowsBelow = 0;
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    writeEofOutput(st, stdout);
    expect(writes).toContain('\n');
  });

  it('emits cursorUp when prevBufferRows > 0', () => {
    const st = makeState('hello', 5);
    st.prevBufferRows = 2;
    st.prevStatusRows = 1;
    st.rowsBelow = 0;
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    writeEofOutput(st, stdout);
    expect(writes.join('')).toContain('\x1b[3A'); // cursorUp(2+1)
    expect(writes).toContain('\n');
  });

  it('emits eraseDown and clears rowsBelow when rowsBelow > 0', () => {
    const st = makeState('');
    st.prevBufferRows = 0;
    st.prevStatusRows = 0;
    st.rowsBelow = 3;
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    writeEofOutput(st, stdout);
    expect(writes.join('')).toContain('\x1b[J');
    expect(st.rowsBelow).toBe(0);
  });
});

// ─── Ctrl+P up-in-buffer path ──────────────────────────────────────────────

describe('Ctrl+P — multi-line buffer up movement', () => {
  it('moves up within a multi-line buffer when possible', () => {
    const buf = 'line one\nline two';
    const st = makeState(buf, buf.length); // cursor at end of second line
    const hist = makeHistory('prev');
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    const handled = handleNavKey(key('p', { ctrl: true }), st, stdout, ctx, repaintFn, hist);
    expect(handled).toBe(true);
    // Must have moved up: cursor should now be before the '\n' (on line one)
    expect(st.input.cursor).toBeLessThan(buf.indexOf('\n'));
    // Repaint must have been called (cursor moved into buffer)
    expect(repaintFn).toHaveBeenCalled();
    // history.back must NOT have been called — we moved within the buffer
    expect(hist.back).not.toHaveBeenCalled();
  });
});

// ─── Ctrl+N down-in-buffer path ────────────────────────────────────────────

describe('Ctrl+N — multi-line buffer down movement', () => {
  it('moves down within a multi-line buffer when possible', () => {
    const buf = 'line one\nline two';
    const st = makeState(buf, 0); // cursor at start of first line
    const hist = makeHistory(null, null);
    const stdout = { columns: 80 } as NodeJS.WriteStream;
    const handled = handleNavKey(key('n', { ctrl: true }), st, stdout, ctx, repaintFn, hist);
    expect(handled).toBe(true);
    // Must have moved down: cursor should now be past the '\n' (on line two)
    expect(st.input.cursor).toBeGreaterThan(buf.indexOf('\n'));
    // Repaint must have been called (cursor moved into buffer)
    expect(repaintFn).toHaveBeenCalled();
    // history.forward must NOT have been called — we moved within the buffer
    expect(hist.forward).not.toHaveBeenCalled();
  });
});

// ─── stdout.columns fallback ───────────────────────────────────────────────

describe('stdout.columns fallback', () => {
  it('uses 80 when stdout.columns is 0/undefined for up', () => {
    const st = makeState('', 0);
    const stdout = { columns: 0 } as NodeJS.WriteStream;
    // Should not throw even with 0/undefined columns.
    const handled = handleNavKey(key('up'), st, stdout, ctx, repaintFn, undefined);
    expect(handled).toBe(true);
  });

  it('uses 80 when stdout.columns is 0/undefined for down', () => {
    const st = makeState('', 0);
    const stdout = { columns: 0 } as NodeJS.WriteStream;
    const handled = handleNavKey(key('down'), st, stdout, ctx, repaintFn, undefined);
    expect(handled).toBe(true);
  });
});
