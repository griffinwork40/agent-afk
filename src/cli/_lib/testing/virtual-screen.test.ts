/**
 * Tests for VirtualScreen
 *
 * Verifies:
 * 1. CUP (cursor positioning) and cursor movement
 * 2. EL (erase in line) and ED (erase in display)
 * 3. Text rendering with auto-wrap
 * 4. LF/CR and scroll region behavior
 * 5. DECSTBM (set scrolling region)
 * 6. Cursor hide/show tracking (DECTCEM)
 * 7. OSC sequence capture
 * 8. Bell count tracking
 * 9. UTF-8 handling and broken-sequence detection (critically: `�` injection)
 * 10. Double-width character rendering
 */

import { describe, it, expect } from 'vitest';
import { VirtualScreen } from './virtual-screen.js';

describe('VirtualScreen', () => {
  describe('basic rendering', () => {
    it('renders simple ASCII text', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello');
      expect(vs.lineAt(1)).toBe('hello');
    });

    it('positions cursor with CUP (H command)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[5;10Hworld');
      expect(vs.lineAt(5)).toContain('world');
      expect(vs.cursor.row).toBe(5);
      expect(vs.cursor.col).toBeGreaterThanOrEqual(10);
    });

    it('moves cursor with CUF (C command)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[5C'); // Move forward 5 from col 1 = col 6
      expect(vs.cursor.col).toBe(6); // cursor at 6 after CUF
      vs.write('x');
      expect(vs.cursor.col).toBe(7); // cursor at 7 after writing 'x'
      expect(vs.lineAt(1)).toBe('     x'); // 5 spaces then x
    });

    it('moves cursor up with CUU (A command)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[10Btest\x1b[5Ax');
      expect(vs.cursor.row).toBe(6); // moved down 10, then up 5
    });
  });

  describe('erase operations', () => {
    it('erases to end of line with EL 0', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello world');
      vs.write('\x1b[6G'); // Position at column 6 (the space after 'hello')
      vs.write('\x1b[K'); // Erase from column 6 to end of line
      const line = vs.lineAt(1);
      // After erase, we have 'hello' (5 chars) + space (col 6) erased = 'hello'
      expect(line).toBe('hello');
    });

    it('erases entire line with EL 2', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello world');
      vs.write('\x1b[2K'); // Erase entire line
      expect(vs.lineAt(1)).toBe('');
    });

    it('erases to end of screen with ED 0', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('line1\nline2\nline3');
      vs.write('\x1b[2;1H'); // Cursor at row 2, col 1
      vs.write('\x1b[J'); // Erase to end of screen
      expect(vs.lineAt(1)).toBe('line1');
      expect(vs.lineAt(2)).toBe('');
      expect(vs.lineAt(3)).toBe('');
    });

    it('clears entire screen with ED 2', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('line1\nline2\nline3');
      vs.write('\x1b[2J'); // Erase entire display
      expect(vs.lineAt(1)).toBe('');
      expect(vs.lineAt(2)).toBe('');
      expect(vs.lineAt(3)).toBe('');
    });

    it('clears scrollback with ED 3', () => {
      const vs = new VirtualScreen(80, 10);
      vs.write('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11');
      expect(vs.scrollbackLines().length).toBeGreaterThan(0);
      vs.write('\x1b[3J'); // Erase display + scrollback
      expect(vs.scrollbackLines().length).toBe(0);
    });
  });

  describe('text wrapping and auto-wrap', () => {
    it('wraps text at column boundary with pendingWrap', () => {
      const vs = new VirtualScreen(10, 5);
      vs.write('12345678901234567890');
      expect(vs.lineAt(1)).toBe('1234567890');
      expect(vs.lineAt(2)).toBe('1234567890');
    });

    it('handles LF correctly after text at end of column', () => {
      const vs = new VirtualScreen(5, 3);
      vs.write('abcde');
      expect(vs.cursor.col).toBe(5);
      expect(vs.getPendingWrap()).toBe(true); // should have pending wrap set
      vs.write('f');
      expect(vs.lineAt(1)).toBe('abcde');
      expect(vs.lineAt(2)).toContain('f');
    });

    it('handles CR (carriage return)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello\rX');
      expect(vs.lineAt(1)).toBe('Xello');
    });

    it('handles TAB', () => {
      const vs = new VirtualScreen(20, 24);
      vs.write('a\tb');
      const line = vs.lineAt(1);
      expect(line).toContain('a');
      expect(line).toContain('b');
      // TAB should advance to next multiple of 8; 'a' at col 1, TAB → col 9, 'b' at 9
    });
  });

  describe('scrolling and scrollback', () => {
    it('pushes lines to scrollback on scroll-up', () => {
      const vs = new VirtualScreen(10, 3);
      vs.write('line1\nline2\nline3\nline4');
      // After 4 lines with 3 rows, one line should be in scrollback
      expect(vs.scrollbackLines().length).toBeGreaterThan(0);
      expect(vs.scrollbackLines()[0]).toBe('line1');
    });

    it('preserves top-anchored region on DECSTBM', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[5;10r'); // Set scroll region rows 5-10
      vs.write('\x1b[10;1H'); // Move to bottom of region
      vs.write('test\n'); // Should scroll within region
      expect(vs.cursor.row).toBe(10); // Stays in region, scrolls up
    });
  });

  describe('cursor positioning edge cases', () => {
    it('clamps cursor to valid ranges', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[100;200H'); // Way out of bounds
      expect(vs.cursor.row).toBe(24);
      expect(vs.cursor.col).toBe(80);
    });

    it('supports VPA (vertical position absolute)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[10d'); // VPA to row 10
      expect(vs.cursor.row).toBe(10);
    });

    it('supports CHA (column absolute)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b[20G'); // CHA to col 20
      expect(vs.cursor.col).toBe(20);
    });
  });

  describe('cursor hide/show (DECTCEM)', () => {
    it('tracks cursor visibility', () => {
      const vs = new VirtualScreen(80, 24);
      expect(vs.isCursorHidden()).toBe(false);
      vs.write('\x1b[?25l'); // Hide cursor
      expect(vs.isCursorHidden()).toBe(true);
      vs.write('\x1b[?25h'); // Show cursor
      expect(vs.isCursorHidden()).toBe(false);
    });
  });

  describe('OSC sequence capture', () => {
    it('captures OSC sequences terminated by BEL', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('\x1b]9;notification\x07');
      const oscs = vs.getOscSequences();
      expect(oscs.length).toBe(1);
      expect(oscs[0]).toBe('9;notification');
    });

    it('ignores OSC sequences in normal output', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('normal text\x1b]8;;http://example.com\x07link');
      const lines = vs.visibleLines();
      expect(lines[0]).toBeDefined();
    });
  });

  describe('bell tracking', () => {
    it('counts BEL characters', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello\x07world\x07\x07');
      expect(vs.getBellCount()).toBe(3);
    });
  });

  describe('UTF-8 handling', () => {
    it('renders complete UTF-8 sequences correctly', () => {
      const vs = new VirtualScreen(80, 24);
      // ▀ is U+2580 (BOX DRAWINGS UPPER HALF BLOCK)
      vs.write('▀');
      expect(vs.lineAt(1)).toContain('▀');
      expect(vs.lineAt(1)).not.toContain('�');
    });

    it('detects broken UTF-8 sequences with replacement char', () => {
      const vs = new VirtualScreen(80, 24);
      // Feed first 2 bytes of ▀ (U+2580 = E2 96 80)
      // then an ESC (0x1B) which breaks the sequence
      const bytes = [0xe2, 0x96, 0x1b, 0x5b, 0x35, 0x6d]; // ▀ U+2580 incomplete, then ESC [ 5 m
      const uint8 = new Uint8Array(bytes);
      vs.write(uint8);
      const line = vs.lineAt(1);
      // The broken sequence should produce '�'
      expect(line).toContain('�');
    });

    it('correctly handles multibyte UTF-8 split across writes', () => {
      const vs = new VirtualScreen(80, 24);
      // ▀ is E2 96 80 (3 bytes)
      // Write first byte alone, then remaining
      vs.write(new Uint8Array([0xe2])); // First byte
      vs.write(new Uint8Array([0x96, 0x80])); // Continuation bytes
      expect(vs.lineAt(1)).toContain('▀');
      expect(vs.lineAt(1)).not.toContain('�');
    });

    it('treats stray continuation bytes as replacement', () => {
      const vs = new VirtualScreen(80, 24);
      // Send a continuation byte (0x80) without a start byte
      vs.write(new Uint8Array([0x80]));
      expect(vs.lineAt(1)).toContain('�');
    });
  });

  describe('double-width characters', () => {
    it('renders double-width emoji without corruption', () => {
      const vs = new VirtualScreen(80, 24);
      // Most emoji are width 2
      vs.write('a😀b');
      const line = vs.lineAt(1);
      expect(line).toContain('a');
      expect(line).toContain('b');
      // Should not contain replacement char for the emoji
      expect(line.match(/�/g) ?? []).toHaveLength(0);
    });

    it('wraps double-width char at column boundary', () => {
      const vs = new VirtualScreen(5, 3);
      vs.write('ab😀cd');
      // 'a' at col 1, 'b' at col 2, emoji (width 2) would span 3-4
      // After emoji, cursor at col 5, then 'c' and 'd' wrap
      expect(vs.lineAt(1).length).toBeGreaterThan(0);
      expect(vs.lineAt(2).length).toBeGreaterThan(0);
    });
  });

  describe('control characters', () => {
    it('ignores unknown C0 controls', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello\x01\x02\x03world');
      expect(vs.lineAt(1)).toBe('helloworld');
    });

    it('ignores DEL (0x7F)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello\x7fworld');
      expect(vs.lineAt(1)).toBe('helloworld');
    });

    it('handles backspace (BS)', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('hello\x08X');
      // BS moves cursor back, then X overwrites
      expect(vs.lineAt(1)).toBe('hellX');
    });
  });

  describe('reset and reuse', () => {
    it('reset() clears all state for reuse', () => {
      const vs = new VirtualScreen(80, 24);
      vs.write('test\x1b[?25l\x1b]9;bell\x07');
      expect(vs.lineAt(1)).toBe('test');
      expect(vs.isCursorHidden()).toBe(true);
      expect(vs.getBellCount()).toBe(0); // BEL in OSC, not ground
      vs.reset();
      expect(vs.lineAt(1)).toBe('');
      expect(vs.isCursorHidden()).toBe(false);
      expect(vs.cursor).toEqual({ row: 1, col: 1 });
    });
  });

  describe('comprehensive flow', () => {
    it('handles a realistic terminal session', () => {
      const vs = new VirtualScreen(80, 24);
      // Simulate: clear, write a banner, position cursor, etc.
      vs.write('\x1b[2J'); // Clear screen
      vs.write('\x1b[1;1H'); // Home
      vs.write('=== Welcome ===\n');
      vs.write('Press Ctrl+C to exit\n');
      vs.write('\x1b[10;1H'); // Move to row 10
      vs.write('Prompt: ');

      expect(vs.lineAt(1)).toContain('Welcome');
      expect(vs.lineAt(2)).toContain('Press');
      expect(vs.lineAt(10)).toContain('Prompt');
    });
  });

  describe('critical: interrupted UTF-8 detection', () => {
    it('produces `�` when escape interrupts UTF-8 sequence', () => {
      const vs = new VirtualScreen(80, 24);
      // Bytes: E2 96 (first 2 of ▀ U+2580) then 1B (ESC)
      // This should detect broken sequence and emit '�'
      const bytes = new Uint8Array([0xe2, 0x96, 0x1b, 0x5b, 0x4a]); // E2 96 = start of ▀, then ESC[J
      vs.write(bytes);
      const line = vs.lineAt(1);
      expect(line).toContain('�');
    });

    it('produces no `�` when full valid UTF-8 is sent', () => {
      const vs = new VirtualScreen(80, 24);
      const fullBox = '▀'; // Valid complete UTF-8 sequence
      vs.write(fullBox);
      const line = vs.lineAt(1);
      expect(line).toContain('▀');
      expect((line.match(/�/g) ?? []).length).toBe(0);
    });

    it('recovers from broken sequence and continues parsing', () => {
      const vs = new VirtualScreen(80, 24);
      // E2 96 (incomplete ▀), then ESC [ 5 m (SGR), then normal text
      const bytes = new Uint8Array([0xe2, 0x96, 0x1b, 0x5b, 0x35, 0x6d, 0x41]); // A is 0x41
      vs.write(bytes);
      const line = vs.lineAt(1);
      expect(line).toContain('�'); // The broken sequence produces replacement
      expect(line).toContain('A'); // And parsing continues
    });
  });
});
