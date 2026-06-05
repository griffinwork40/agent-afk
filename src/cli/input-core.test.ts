import { describe, expect, it } from 'vitest';
import { InputCore } from './input-core.js';

describe('InputCore', () => {
  describe('seed', () => {
    it('seeds the buffer with the cursor at the end', () => {
      expect(InputCore.seed('hello')).toEqual({ buffer: 'hello', cursor: 5 });
    });

    it('preserves JavaScript string index semantics', () => {
      const state = InputCore.seed('🙂');
      expect(state.cursor).toBe('🙂'.length);
    });
  });

  describe('insert', () => {
    it('inserts text at the cursor and advances the cursor', () => {
      const start = InputCore.seed('ac');
      const middle = InputCore.moveLeft(start);
      expect(InputCore.insert(middle, 'b')).toEqual({ buffer: 'abc', cursor: 2 });
    });
  });

  describe('replaceRange', () => {
    it('replaces a selected range and lands the cursor at the replacement end', () => {
      const state = InputCore.seed('hello world');
      expect(
        InputCore.replaceRange(state, { start: 6, end: 11 }, 'agent'),
      ).toEqual({ buffer: 'hello agent', cursor: 11 });
    });

    it('deletes a selected range when replacement text is empty', () => {
      const state = InputCore.seed('hello world');
      expect(
        InputCore.replaceRange(state, { start: 5, end: 11 }, ''),
      ).toEqual({ buffer: 'hello', cursor: 5 });
    });
  });

  describe('deletion helpers', () => {
    it('backspace removes the grapheme before the cursor', () => {
      const state = InputCore.seed('agent');
      expect(InputCore.backspace(state)).toEqual({ buffer: 'agen', cursor: 4 });
    });

    it('deleteForward removes the grapheme at the cursor', () => {
      const seeded = InputCore.seed('agent');
      const atMiddle = InputCore.moveLeft(InputCore.moveLeft(seeded));
      expect(InputCore.deleteForward(atMiddle)).toEqual({ buffer: 'aget', cursor: 3 });
    });

    it('backspace removes a whole emoji cluster', () => {
      const state = InputCore.seed('a🙂');
      expect(InputCore.backspace(state)).toEqual({ buffer: 'a', cursor: 1 });
    });

    it('deleteForward removes a whole combining cluster', () => {
      const state = InputCore.moveHome(InputCore.seed('éa'));
      expect(InputCore.deleteForward(state)).toEqual({ buffer: 'a', cursor: 0 });
    });
  });

  describe('word deletion (Option+Delete / Option+Fn-Delete)', () => {
    it('deleteWordBackward removes the word before the cursor', () => {
      const state = InputCore.seed('hello world');
      expect(InputCore.deleteWordBackward(state)).toEqual({ buffer: 'hello ', cursor: 6 });
    });

    it('deleteWordBackward eats trailing whitespace then the previous word', () => {
      const state = InputCore.seed('hello world   ');
      expect(InputCore.deleteWordBackward(state)).toEqual({ buffer: 'hello ', cursor: 6 });
    });

    it('deleteWordBackward eats only whitespace when cursor sits in pure whitespace at start', () => {
      const seeded = InputCore.seed('   abc');
      // cursor between spaces (index 2) → there's no word before; collapse all whitespace
      const at = { buffer: seeded.buffer, cursor: 2 };
      expect(InputCore.deleteWordBackward(at)).toEqual({ buffer: ' abc', cursor: 0 });
    });

    it('deleteWordBackward is a no-op at start of buffer', () => {
      const state = InputCore.moveHome(InputCore.seed('hello'));
      expect(InputCore.deleteWordBackward(state)).toBe(state);
    });

    it('deleteWordForward removes the word after the cursor', () => {
      const state = InputCore.moveHome(InputCore.seed('hello world'));
      expect(InputCore.deleteWordForward(state)).toEqual({ buffer: ' world', cursor: 0 });
    });

    it('deleteWordForward eats leading whitespace then the next word', () => {
      const state = InputCore.moveHome(InputCore.seed('   hello world'));
      expect(InputCore.deleteWordForward(state)).toEqual({ buffer: ' world', cursor: 0 });
    });

    it('deleteWordForward is a no-op at end of buffer', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.deleteWordForward(state)).toBe(state);
    });
  });

  describe('line deletion (Cmd+Delete / Ctrl+U / Ctrl+K)', () => {
    it('deleteToLineStart removes everything before the cursor on the current line', () => {
      const state = InputCore.seed('hello world');
      expect(InputCore.deleteToLineStart(state)).toEqual({ buffer: '', cursor: 0 });
    });

    it('deleteToLineStart only deletes back to the previous newline, not across it', () => {
      const state = InputCore.seed('first\nsecond');
      expect(InputCore.deleteToLineStart(state)).toEqual({ buffer: 'first\n', cursor: 6 });
    });

    it('deleteToLineStart is a no-op at start of line', () => {
      const state = InputCore.moveHome(InputCore.seed('hello'));
      expect(InputCore.deleteToLineStart(state)).toBe(state);
    });

    it('deleteToLineEnd removes everything after the cursor on the current line', () => {
      const state = InputCore.moveHome(InputCore.seed('hello world'));
      expect(InputCore.deleteToLineEnd(state)).toEqual({ buffer: '', cursor: 0 });
    });

    it('deleteToLineEnd stops at the next newline', () => {
      const state = InputCore.moveHome(InputCore.seed('first\nsecond'));
      expect(InputCore.deleteToLineEnd(state)).toEqual({ buffer: '\nsecond', cursor: 0 });
    });

    it('deleteToLineEnd is a no-op at end of line', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.deleteToLineEnd(state)).toBe(state);
    });
  });

  describe('movement', () => {
    it('moves left and right within the current buffer', () => {
      const seeded = InputCore.seed('agent');
      const left = InputCore.moveLeft(InputCore.moveLeft(seeded));
      expect(left).toEqual({ buffer: 'agent', cursor: 3 });
      expect(InputCore.moveRight(left)).toEqual({ buffer: 'agent', cursor: 4 });
    });

    it('moves left and right by grapheme cluster boundaries', () => {
      const seeded = InputCore.seed('a🙂b');
      const left = InputCore.moveLeft(InputCore.moveLeft(seeded));
      expect(left.cursor).toBe(1);
      expect(InputCore.moveRight(left).cursor).toBe(3);
    });

    it('moves to home and end', () => {
      const seeded = InputCore.seed('agent');
      const home = InputCore.moveHome(seeded);
      expect(home).toEqual({ buffer: 'agent', cursor: 0 });
      expect(InputCore.moveEnd(home)).toEqual({ buffer: 'agent', cursor: 5 });
    });
  });

  describe('line movement (Ctrl+A / Ctrl+E)', () => {
    it('moveLineStart moves to start of current line in a multi-line buffer', () => {
      // buffer: "first\nsecond", cursor at end of "second" (index 12)
      const state = InputCore.seed('first\nsecond');
      expect(InputCore.moveLineStart(state)).toEqual({ buffer: 'first\nsecond', cursor: 6 });
    });

    it('moveLineStart moves to buffer start on first line', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.moveLineStart(state)).toEqual({ buffer: 'hello', cursor: 0 });
    });

    it('moveLineStart is a no-op when already at line start', () => {
      const state = { buffer: 'first\nsecond', cursor: 6 };
      expect(InputCore.moveLineStart(state)).toBe(state);
    });

    it('moveLineEnd moves to end of current line in a multi-line buffer', () => {
      // buffer: "first\nsecond", cursor at start of first line (index 0)
      const state = InputCore.moveHome(InputCore.seed('first\nsecond'));
      expect(InputCore.moveLineEnd(state)).toEqual({ buffer: 'first\nsecond', cursor: 5 });
    });

    it('moveLineEnd moves to buffer end on last line', () => {
      const state = InputCore.moveHome(InputCore.seed('hello'));
      expect(InputCore.moveLineEnd(state)).toEqual({ buffer: 'hello', cursor: 5 });
    });

    it('moveLineEnd is a no-op when already at line end', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.moveLineEnd(state)).toBe(state);
    });
  });

  describe('word movement (Alt+B / Alt+F)', () => {
    it('moveWordBackward moves to start of previous word', () => {
      const state = InputCore.seed('hello world');
      expect(InputCore.moveWordBackward(state)).toEqual({ buffer: 'hello world', cursor: 6 });
    });

    it('moveWordBackward skips whitespace before the word', () => {
      const state = InputCore.seed('hello   world   ');
      expect(InputCore.moveWordBackward(state)).toEqual({ buffer: 'hello   world   ', cursor: 8 });
    });

    it('moveWordBackward is a no-op at buffer start', () => {
      const state = InputCore.moveHome(InputCore.seed('hello'));
      expect(InputCore.moveWordBackward(state)).toBe(state);
    });

    it('moveWordForward moves to end of next word', () => {
      const state = InputCore.moveHome(InputCore.seed('hello world'));
      expect(InputCore.moveWordForward(state)).toEqual({ buffer: 'hello world', cursor: 5 });
    });

    it('moveWordForward skips leading whitespace then the word', () => {
      const state = InputCore.seed('hello   world');
      // cursor at end of 'hello' (5); skip '   ' then 'world'
      const mid = InputCore.moveWordBackward(InputCore.moveEnd(InputCore.seed('hello   world')));
      expect(InputCore.moveWordForward(mid)).toEqual({ buffer: 'hello   world', cursor: 13 });
    });

    it('moveWordForward is a no-op at buffer end', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.moveWordForward(state)).toBe(state);
    });
  });

  describe('moveUpLine / moveDownLine (discriminated union)', () => {
    // Use a wide terminal width so each logical line occupies exactly one visual row.
    const W = 200;
    const P = 5; // promptVisibleLen

    it('moveUpLine returns { moved: false } on first visual row', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.moveUpLine(state, W, P)).toEqual({ moved: false });
    });

    it('moveUpLine moves from line 2 to line 1, preserving column', () => {
      // "line1\nline2", cursor at end (index 11)
      // line2 = "line2" at index 6..11; cursor on visual row 1, col 5+P=10
      const state = InputCore.seed('line1\nline2');
      const result = InputCore.moveUpLine(state, W, P);
      expect(result.moved).toBe(true);
      if (result.moved) {
        // Should land on row 0 at same column as end of "line2" (col 9)
        // line1 has 5 chars so best landing is cursor=5 (end of line1)
        expect(result.state.buffer).toBe('line1\nline2');
        expect(result.state.cursor).toBeGreaterThanOrEqual(0);
        expect(result.state.cursor).toBeLessThanOrEqual(5);
      }
    });

    it('moveDownLine returns { moved: false } on last visual row', () => {
      const state = InputCore.seed('hello');
      expect(InputCore.moveDownLine(state, W, P)).toEqual({ moved: false });
    });

    it('moveDownLine moves from line 1 to line 2', () => {
      // "line1\nline2", cursor at start of line1 (index 0)
      const state = InputCore.moveHome(InputCore.seed('line1\nline2'));
      const result = InputCore.moveDownLine(state, W, P);
      expect(result.moved).toBe(true);
      if (result.moved) {
        // Should land on row 1 (line2 starts at index 6)
        expect(result.state.cursor).toBeGreaterThanOrEqual(6);
        expect(result.state.cursor).toBeLessThanOrEqual(11);
      }
    });

    it('moveUpLine then moveDownLine returns to same position for symmetric buffers', () => {
      const state = InputCore.seed('abc\ndef');
      const up = InputCore.moveUpLine(state, W, P);
      expect(up.moved).toBe(true);
      if (up.moved) {
        const down = InputCore.moveDownLine(up.state, W, P);
        expect(down.moved).toBe(true);
        if (down.moved) {
          expect(down.state.cursor).toBe(state.cursor);
        }
      }
    });
  });

  describe('no-op behavior', () => {
    it('returns the same state when backspacing at the start', () => {
      const state = InputCore.moveHome(InputCore.seed('agent'));
      expect(InputCore.backspace(state)).toBe(state);
    });

    it('returns the same state when deleting forward at the end', () => {
      const state = InputCore.seed('agent');
      expect(InputCore.deleteForward(state)).toBe(state);
    });

    it('returns the same state when moving left at the start', () => {
      const state = InputCore.moveHome(InputCore.seed('agent'));
      expect(InputCore.moveLeft(state)).toBe(state);
    });

    it('returns the same state when moving right at the end', () => {
      const state = InputCore.seed('agent');
      expect(InputCore.moveRight(state)).toBe(state);
    });

    it('returns the same state when moving home from home or end from end', () => {
      const home = InputCore.moveHome(InputCore.seed('agent'));
      const end = InputCore.seed('agent');
      expect(InputCore.moveHome(home)).toBe(home);
      expect(InputCore.moveEnd(end)).toBe(end);
    });

    it('returns the same state for empty inserts and empty replacements', () => {
      const state = InputCore.seed('agent');
      expect(InputCore.insert(state, '')).toBe(state);
      expect(InputCore.replaceRange(state, { start: 2, end: 2 }, '')).toBe(state);
    });
  });
});
