/**
 * Tests for TerminalCompositor — word/line navigation (readline parity).
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

// ---------------------------------------------------------------------------
// Word/line navigation (readline parity) — Option+arrow, Cmd+arrow,
// Ctrl+A/E/W/U/K, Alt+B/F, Option+Delete, etc.
//
// Strategy: seed a known buffer + cursor (via typed chars + `left` arrows),
// emit the binding under test, then insert a marker char and assert it
// landed at the expected position in the buffer. Black-box parity with the
// existing `left/right move cursor within buffer` test on line ~983.
// ---------------------------------------------------------------------------
describe('TerminalCompositor — word/line navigation (readline parity)', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  // Helper: type each char of `text` so the buffer reaches `text` with
  // cursor at end. Mirrors the typing pattern used throughout this file.
  const type = (s: string) => {
    for (const ch of s) {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
  };

  describe('cursor movement', () => {
    it('Ctrl+A moves to start of line (Cmd+← via terminal default remap)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello');
      stdin.emit('keypress', undefined, { name: 'a', ctrl: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('Xhello');
    });

    it('Ctrl+E moves to end of line (Cmd+→ via terminal default remap)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello');
      // Move to start, then Ctrl+E to jump back to end.
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'e', ctrl: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('helloX');
    });

    it('Option+← (meta+left) moves backward one word', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('foo bar baz');
      // Cursor at end (11). Option+← lands at start of 'baz' (cursor=8).
      stdin.emit('keypress', undefined, { name: 'left', meta: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('foo bar Xbaz');
    });

    it('Option+→ (meta+right) moves forward one word', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('foo bar baz');
      stdin.emit('keypress', undefined, { name: 'home' });
      // Cursor at 0. Option+→ lands at end of 'foo' (cursor=3).
      stdin.emit('keypress', undefined, { name: 'right', meta: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('fooX bar baz');
    });

    it('Ctrl+← (ctrl+left) moves backward one word (Linux convention)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('alpha beta');
      stdin.emit('keypress', undefined, { name: 'left', ctrl: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('alpha Xbeta');
    });

    it('Ctrl+→ (ctrl+right) moves forward one word', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('alpha beta');
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'right', ctrl: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('alphaX beta');
    });

    it('Option+B (Esc-prefixed, meta+b) moves backward one word', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('one two three');
      stdin.emit('keypress', 'b', { name: 'b', meta: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('one two Xthree');
    });

    it('Option+F (Esc-prefixed, meta+f) moves forward one word', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('one two three');
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', 'f', { name: 'f', meta: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('oneX two three');
    });

    it('word-nav across whitespace boundary skips the gap', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('a   b');
      // Cursor at 5 (end). One Option+← jumps over the spaces AND over 'b'
      // to land at start of 'b' (cursor=4). Match InputCore.moveWordBackward
      // semantics: skip trailing whitespace, then preceding non-whitespace run.
      stdin.emit('keypress', undefined, { name: 'left', meta: true });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('a   Xb');
    });
  });

  describe('word-level delete', () => {
    it('Ctrl+W deletes word backward', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello world');
      stdin.emit('keypress', undefined, { name: 'w', ctrl: true });
      expect(c.getBuffer().text).toBe('hello ');
    });

    it('Option+Delete (meta+backspace) deletes word backward', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello world');
      stdin.emit('keypress', undefined, { name: 'backspace', meta: true });
      expect(c.getBuffer().text).toBe('hello ');
    });

    it('Option+Fn-Delete (meta+delete) deletes word forward', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello world');
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'delete', meta: true });
      expect(c.getBuffer().text).toBe(' world');
    });

    it('plain backspace still does char-erase (meta-variant does not regress unmodified key)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('abc');
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getBuffer().text).toBe('ab');
    });

    it('plain delete still does forward char-erase', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('abc');
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'delete' });
      expect(c.getBuffer().text).toBe('bc');
    });
  });

  describe('line-level delete', () => {
    it('Ctrl+U deletes from cursor to start of line', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello world');
      // Cursor at 11 (end). Ctrl+U kills the entire line back to start.
      stdin.emit('keypress', undefined, { name: 'u', ctrl: true });
      expect(c.getBuffer().text).toBe('');
    });

    it('Ctrl+K deletes from cursor to end of line', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('hello world');
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'k', ctrl: true });
      expect(c.getBuffer().text).toBe('');
    });

    it('Ctrl+U mid-buffer deletes only the prefix before the cursor', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      type('abcdef');
      // Move left 3 times → cursor=3 (between c and d). Ctrl+U deletes 'abc'.
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'u', ctrl: true });
      expect(c.getBuffer().text).toBe('def');
    });
  });

  describe('history.resetRecall coordination', () => {
    // Per the existing convention (e.g. backspace at line 1591), any
    // buffer-modifying op must call history.resetRecall() so the next
    // ↑/↓ recall starts from the edited buffer rather than the prior
    // recalled snapshot. Pure cursor moves must NOT reset recall —
    // verified by omission below (no test asserts that Ctrl+A/E/word-nav
    // resets recall, because they shouldn't).

    it('Ctrl+W resets history recall', async () => {
      const resetRecall = vi.fn();
      const history = {
        push: vi.fn(),
        back: vi.fn(() => null),
        forward: vi.fn(() => null),
        resetRecall,
        get inRecall() { return false; },
      };
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      type('hello world');
      resetRecall.mockClear();
      stdin.emit('keypress', undefined, { name: 'w', ctrl: true });
      expect(resetRecall).toHaveBeenCalledTimes(1);
      expect(c.getBuffer().text).toBe('hello ');
    });

    it('Ctrl+U resets history recall', async () => {
      const resetRecall = vi.fn();
      const history = {
        push: vi.fn(),
        back: vi.fn(() => null),
        forward: vi.fn(() => null),
        resetRecall,
        get inRecall() { return false; },
      };
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      type('abc');
      resetRecall.mockClear();
      stdin.emit('keypress', undefined, { name: 'u', ctrl: true });
      expect(resetRecall).toHaveBeenCalledTimes(1);
    });
  });

  describe('no-op safety at edges', () => {
    it('Option+← at buffer start is a silent no-op', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Empty buffer, cursor at 0.
      stdin.emit('keypress', undefined, { name: 'left', meta: true });
      // No throw, no buffer change.
      expect(c.getBuffer().text).toBe('');
    });

    it('Ctrl+W on empty buffer is a silent no-op (does not reset recall)', async () => {
      const resetRecall = vi.fn();
      const history = {
        push: vi.fn(),
        back: vi.fn(() => null),
        forward: vi.fn(() => null),
        resetRecall,
        get inRecall() { return false; },
      };
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      resetRecall.mockClear();
      stdin.emit('keypress', undefined, { name: 'w', ctrl: true });
      // deleteWordBackward returns input unchanged → resetRecall not called.
      expect(resetRecall).not.toHaveBeenCalled();
      expect(c.getBuffer().text).toBe('');
    });

    it('Ctrl+B (background-turn binding) is preserved and does NOT trigger char-nav', async () => {
      // Regression guard: AFK repurposes Ctrl+B for "background current
      // turn" — see HOT context. Adding word-nav bindings must not
      // accidentally bind Ctrl+B to char-back. Default input mode is
      // `'streaming'`, where Ctrl+B fires onBackground.
      const onBackground = vi.fn();
      const c = new TerminalCompositor({
        stdout,
        stdin,
        onCancel: vi.fn(),
        onBackground,
      });
      await c.arm();
      type('abc');
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      // Buffer must be untouched (no implicit cursor-back).
      expect(c.getBuffer().text).toBe('abc');
      expect(onBackground).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// renderDropdownRows() — byte-level coverage: candidate text in stdout frame
// ---------------------------------------------------------------------------

