/**
 * Unit tests for `src/cli/input/selectors.ts`.
 *
 * Strategy:
 *   - Non-TTY / empty-choices paths: testable without any I/O — the functions
 *     return `null` immediately when stdin/stdout are not TTYs.
 *   - TTY keypress paths: tested by overriding `process.stdout.isTTY` and
 *     `process.stdin.isTTY` to true, then driving the keypress event loop
 *     by directly emitting events on `process.stdin` after the selector
 *     starts.  `process.stdin.setRawMode` is mocked so no real terminal is
 *     needed.
 *   - `CUSTOM_ANSWER_SENTINEL`: exported constant, pure verification.
 *
 * Per POSIX guard R4: no test is gated on `process.platform`. All terminal
 * I/O is intercepted via mock/spy on process.stdin/stdout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the two TTY-dependent imports so we can run tests without a real tty.
// ---------------------------------------------------------------------------

const { mockEmitKeypress } = vi.hoisted(() => ({
  mockEmitKeypress: vi.fn(),
}));

vi.mock('./emit-keypress.js', () => ({
  emitKeypressEventsImmediateEscape: mockEmitKeypress,
}));

// Sanitize mock: just pass through to keep tests readable.
vi.mock('../_lib/sanitize.js', () => ({
  sanitizeSchemaString: (s: string) => s,
}));

// palette mock: return ANSI-stripped values so rendered output is predictable.
vi.mock('../palette.js', () => ({
  palette: {
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// SUT imported after mocks.
import { renderSelector, renderMultiSelector, CUSTOM_ANSWER_SENTINEL } from './selectors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured stdout writes. */
let stdoutWrites: string[] = [];
const mockWrite = vi.fn((chunk: unknown) => {
  stdoutWrites.push(String(chunk));
  return true;
});

/** Registered stdin keypress listeners. */
type KeypressListener = (_char: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => void;
let keypressListeners: KeypressListener[] = [];

const mockSetRawMode = vi.fn();
const mockRemoveListener = vi.fn((_evt: string, listener: KeypressListener) => {
  keypressListeners = keypressListeners.filter((l) => l !== listener);
});
const mockOn = vi.fn((_evt: string, listener: KeypressListener) => {
  if (_evt === 'keypress') keypressListeners.push(listener);
});

/** Emit a synthetic keypress to all registered listeners. */
function pressKey(key: { name?: string; ctrl?: boolean; sequence?: string }): void {
  for (const l of [...keypressListeners]) {
    l(undefined, key);
  }
}

/** Saved descriptors to restore after each test. */
let savedStdoutIsTTY: PropertyDescriptor | undefined;
let savedStdinIsTTY: PropertyDescriptor | undefined;
let savedStdoutWrite: typeof process.stdout.write;
let savedStdinOn: typeof process.stdin.on;
let savedStdinRemoveListener: typeof process.stdin.removeListener;
let savedSetRawMode: typeof process.stdin.setRawMode | undefined;

beforeEach(() => {
  stdoutWrites = [];
  keypressListeners = [];
  mockWrite.mockClear();
  mockSetRawMode.mockClear();
  mockRemoveListener.mockClear();
  mockOn.mockClear();
  mockEmitKeypress.mockClear();

  // Override process.stdout.isTTY and .write.
  savedStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  savedStdoutWrite = process.stdout.write.bind(process.stdout);
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  process.stdout.write = mockWrite as unknown as typeof process.stdout.write;

  // Override process.stdin.isTTY, .on, .removeListener, .setRawMode.
  savedStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  savedStdinOn = process.stdin.on.bind(process.stdin);
  savedStdinRemoveListener = process.stdin.removeListener.bind(process.stdin);
  savedSetRawMode = process.stdin.setRawMode;

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
  process.stdin.on = mockOn as unknown as typeof process.stdin.on;
  process.stdin.removeListener = mockRemoveListener as unknown as typeof process.stdin.removeListener;
  process.stdin.setRawMode = mockSetRawMode;
});

afterEach(() => {
  // Restore process.stdout.
  process.stdout.write = savedStdoutWrite;
  if (savedStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', savedStdoutIsTTY);
  } else {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true, writable: true });
  }

  // Restore process.stdin.
  process.stdin.on = savedStdinOn;
  process.stdin.removeListener = savedStdinRemoveListener;
  if (savedSetRawMode !== undefined) {
    process.stdin.setRawMode = savedSetRawMode;
  }
  if (savedStdinIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', savedStdinIsTTY);
  } else {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true, writable: true });
  }
});

// ---------------------------------------------------------------------------
// CUSTOM_ANSWER_SENTINEL
// ---------------------------------------------------------------------------

describe('CUSTOM_ANSWER_SENTINEL', () => {
  it('is a non-empty string with a recognisable pencil glyph', () => {
    expect(typeof CUSTOM_ANSWER_SENTINEL).toBe('string');
    expect(CUSTOM_ANSWER_SENTINEL.length).toBeGreaterThan(0);
    // The sentinel embeds U+270E (LOWER RIGHT PENCIL).
    expect(CUSTOM_ANSWER_SENTINEL).toContain('\u270E');
  });
});

// ---------------------------------------------------------------------------
// renderSelector — non-TTY / edge cases
// ---------------------------------------------------------------------------

describe('renderSelector — non-TTY fallback', () => {
  it('returns null when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true, writable: true });
    const result = await renderSelector(['a', 'b'], new AbortController().signal);
    expect(result).toBeNull();
  });

  it('returns null when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
    const result = await renderSelector(['a', 'b'], new AbortController().signal);
    expect(result).toBeNull();
  });

  it('returns null when choices array is empty', async () => {
    const result = await renderSelector([], new AbortController().signal);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderSelector — TTY keypress navigation
// ---------------------------------------------------------------------------

describe('renderSelector — TTY keypress', () => {
  it('returns the index of the initially-selected item on Enter', async () => {
    const p = renderSelector(['alpha', 'beta', 'gamma'], new AbortController().signal);
    // Flush the microtask queue so the promise's listeners are registered.
    await Promise.resolve();
    // Press Enter immediately (cursor starts at 0).
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toBe(0);
  });

  it('moves cursor down and confirms selection', async () => {
    const p = renderSelector(['alpha', 'beta', 'gamma'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'down' });
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toBe(1);
  });

  it('moves cursor up (and stays at 0 when already at top)', async () => {
    const p = renderSelector(['alpha', 'beta', 'gamma'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'up' }); // already at 0, should stay
    pressKey({ name: 'down' });
    pressKey({ name: 'up' }); // back to 0
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toBe(0);
  });

  it('returns :cancel on Escape', async () => {
    const p = renderSelector(['alpha', 'beta'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'escape' });
    const result = await p;
    expect(result).toBe(':cancel');
  });

  it('returns :cancel on Ctrl+C', async () => {
    const p = renderSelector(['alpha', 'beta'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ ctrl: true, name: 'c' });
    const result = await p;
    expect(result).toBe(':cancel');
  });

  it('handles VT-sequence up/down arrow (sequence property)', async () => {
    const p = renderSelector(['alpha', 'beta', 'gamma'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ sequence: '\x1b[B' }); // down
    pressKey({ sequence: '\x1b[A' }); // up
    pressKey({ name: 'enter' });
    const result = await p;
    expect(result).toBe(0);
  });

  it('emits initial render to stdout', async () => {
    const p = renderSelector(['alpha', 'beta'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    expect(stdoutWrites.length).toBeGreaterThan(0);
    const combined = stdoutWrites.join('');
    expect(combined).toContain('alpha');
    expect(combined).toContain('beta');
  });

  it('repaints (cursor-up + erase) on navigation keypress', async () => {
    const p = renderSelector(['alpha', 'beta'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'down' }); // triggers repaint
    pressKey({ name: 'return' });
    await p;
    const combined = stdoutWrites.join('');
    // repaint sequence: ESC [ N A (cursor up)
    expect(combined).toMatch(/\x1b\[\d+A/);
  });

  it('sets raw mode on entry and restores it on exit', async () => {
    const p = renderSelector(['alpha'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    // setRawMode(true) then setRawMode(false).
    expect(mockSetRawMode).toHaveBeenCalledWith(true);
    expect(mockSetRawMode).toHaveBeenCalledWith(false);
  });

  it('calls emitKeypressEventsImmediateEscape to set up fast-ESC mode', async () => {
    const p = renderSelector(['alpha'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    expect(mockEmitKeypress).toHaveBeenCalledOnce();
  });

  it('shows scroll hint when choices exceed MAX_VISIBLE (10)', async () => {
    const choices = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const p = renderSelector(choices, new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    const combined = stdoutWrites.join('');
    // Scroll hint includes "of 12".
    expect(combined).toContain('of 12');
  });

  it('scrolls down when cursor moves past the visible window', async () => {
    // 11 items; visible window is 10. Moving cursor past item 9 should scroll.
    const choices = Array.from({ length: 11 }, (_, i) => `item-${i}`);
    const p = renderSelector(choices, new AbortController().signal);
    await Promise.resolve();
    // Move to item 10 (index 10) by pressing down 10 times.
    for (let i = 0; i < 10; i++) pressKey({ name: 'down' });
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// renderMultiSelector — non-TTY / edge cases
// ---------------------------------------------------------------------------

describe('renderMultiSelector — non-TTY fallback', () => {
  it('returns null when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true, writable: true });
    const result = await renderMultiSelector(['a', 'b'], new AbortController().signal);
    expect(result).toBeNull();
  });

  it('returns null when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
    const result = await renderMultiSelector(['a', 'b'], new AbortController().signal);
    expect(result).toBeNull();
  });

  it('returns null when choices array is empty', async () => {
    const result = await renderMultiSelector([], new AbortController().signal);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderMultiSelector — TTY keypress navigation
// ---------------------------------------------------------------------------

describe('renderMultiSelector — TTY keypress', () => {
  it('returns empty array when nothing is toggled and Enter is pressed', async () => {
    const p = renderMultiSelector(['a', 'b', 'c'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toEqual([]);
  });

  it('returns :cancel on Escape', async () => {
    const p = renderMultiSelector(['a', 'b'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'escape' });
    const result = await p;
    expect(result).toBe(':cancel');
  });

  it('returns :cancel on Ctrl+C', async () => {
    const p = renderMultiSelector(['a', 'b'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ ctrl: true, name: 'c' });
    const result = await p;
    expect(result).toBe(':cancel');
  });

  it('toggles the first item with Space, returns [0] on Enter', async () => {
    const p = renderMultiSelector(['a', 'b', 'c'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'space' }); // select index 0
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toEqual([0]);
  });

  it('toggles multiple items and returns them sorted', async () => {
    const p = renderMultiSelector(['a', 'b', 'c'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'down' });  // cursor → 1
    pressKey({ name: 'space' }); // select index 1
    pressKey({ name: 'down' });  // cursor → 2
    pressKey({ name: 'space' }); // select index 2
    pressKey({ name: 'up' });    // cursor → 1
    pressKey({ name: 'space' }); // deselect index 1
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toEqual([2]);
  });

  it('emits initial render with choice labels', async () => {
    const p = renderMultiSelector(['alpha', 'beta'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    const combined = stdoutWrites.join('');
    expect(combined).toContain('alpha');
    expect(combined).toContain('beta');
  });

  it('sets raw mode on entry and restores on exit', async () => {
    const p = renderMultiSelector(['alpha'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    expect(mockSetRawMode).toHaveBeenCalledWith(true);
    expect(mockSetRawMode).toHaveBeenCalledWith(false);
  });

  it('navigates with VT up/down arrow sequences', async () => {
    const p = renderMultiSelector(['alpha', 'beta', 'gamma'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ sequence: '\x1b[B' }); // down → cursor 1
    pressKey({ name: 'space' });       // select 1
    pressKey({ sequence: '\x1b[A' }); // up → cursor 0
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toEqual([1]);
  });

  it('shows scroll hint when choices exceed MAX_VISIBLE (10)', async () => {
    const choices = Array.from({ length: 12 }, (_, i) => `opt-${i}`);
    const p = renderMultiSelector(choices, new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'return' });
    await p;
    const combined = stdoutWrites.join('');
    expect(combined).toContain('of 12');
  });

  it('scrolls down when cursor moves past the visible window', async () => {
    const choices = Array.from({ length: 11 }, (_, i) => `opt-${i}`);
    const p = renderMultiSelector(choices, new AbortController().signal);
    await Promise.resolve();
    for (let i = 0; i < 10; i++) pressKey({ name: 'down' });
    pressKey({ name: 'space' }); // select index 10
    pressKey({ name: 'return' });
    const result = await p;
    expect(result).toEqual([10]);
  });

  it('repaints on Space toggle', async () => {
    const p = renderMultiSelector(['a', 'b'], new AbortController().signal);
    await Promise.resolve();
    pressKey({ name: 'space' }); // triggers repaint
    pressKey({ name: 'return' });
    await p;
    const combined = stdoutWrites.join('');
    expect(combined).toMatch(/\x1b\[\d+A/); // cursor-up escape = repaint
  });
});
