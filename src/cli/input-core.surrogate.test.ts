/**
 * Regression test for #4960: InputCore.moveUpLine / moveDownLine must never
 * land the cursor at a UTF-16 index that falls inside a surrogate pair.
 *
 * Root cause: the landing-index search iterated every UTF-16 index 0..n,
 * including indices between the two halves of a surrogate pair. Under
 * string-width 8.3.0 a lone low-surrogate measured 0 columns, so the
 * mid-pair index tied with the boundary index to its left and lost
 * (leftmost-wins tie-break). Under string-width 9.0.0 it measures 1 column,
 * so it could win outright and become the chosen landing index — placing the
 * cursor inside the emoji.
 *
 * Fix: the landing loops now skip indices that are not grapheme boundaries,
 * so a mid-surrogate-pair index is never a candidate regardless of how
 * string-width measures a partial slice.
 *
 * These tests FAIL on the unfixed code and PASS after the fix.
 */

import { describe, expect, it } from 'vitest';
import { InputCore } from './input-core.js';

/** Returns true when `index` falls strictly inside a surrogate pair. */
function isMidSurrogate(buffer: string, index: number): boolean {
  if (index <= 0 || index >= buffer.length) return false;
  const hi = buffer.charCodeAt(index - 1);
  const lo = buffer.charCodeAt(index);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * Assert that every landing index produced by moveUpLine and moveDownLine
 * over all cursor positions in `buffer` never falls inside a surrogate pair.
 */
function assertNeverMidSurrogate(
  buffer: string,
  terminalWidth: number,
  promptVisibleLen: number,
): void {
  for (let cursor = 0; cursor <= buffer.length; cursor++) {
    const state = { buffer, cursor };

    const up = InputCore.moveUpLine(state, terminalWidth, promptVisibleLen);
    if (up.moved) {
      const landing = up.state.cursor;
      expect(
        isMidSurrogate(buffer, landing),
        `moveUpLine from cursor=${cursor} landed at ${landing} which is inside a surrogate pair`,
      ).toBe(false);
    }

    const down = InputCore.moveDownLine(state, terminalWidth, promptVisibleLen);
    if (down.moved) {
      const landing = down.state.cursor;
      expect(
        isMidSurrogate(buffer, landing),
        `moveDownLine from cursor=${cursor} landed at ${landing} which is inside a surrogate pair`,
      ).toBe(false);
    }
  }
}

describe('InputCore surrogate-pair safety (#4960)', () => {
  // -------------------------------------------------------------------------
  // Explicit spot-checks for the exact scenario described in the issue:
  // buffer 'a🙂b🙂c🙂d', width 4, promptLen 0, cursor 1 (column 1) → down.
  //
  // emoji-wrap buffer layout (width 4):
  //   row 0: a🙂   (indices 0-3: a=0, 🙂=[1,2], wrap after col 3)
  //   row 1: b🙂   (indices 3-6: b=3, 🙂=[4,5], wrap after col 3)
  //   row 2: c🙂d  (indices 6-10: c=6, 🙂=[7,8], d=9)
  //
  // Mid-surrogate indices: 2 (inside first 🙂), 5 (inside second 🙂), 8 (inside third 🙂).
  // -------------------------------------------------------------------------
  const EMOJI_WRAP = 'a\u{1F642}b\u{1F642}c\u{1F642}d'; // 'a🙂b🙂c🙂d', length 10

  it('moveDownLine from cursor=1 (col 1, row 0) does NOT land at index 5 (mid-surrogate)', () => {
    const result = InputCore.moveDownLine({ buffer: EMOJI_WRAP, cursor: 1 }, 4, 0);
    expect(result.moved).toBe(true);
    if (result.moved) {
      expect(result.state.cursor).not.toBe(5);
      expect(isMidSurrogate(EMOJI_WRAP, result.state.cursor)).toBe(false);
      // Should land at index 4 (start of second 🙂, column 1 on row 1 matches source col 1)
      expect(result.state.cursor).toBe(4);
    }
  });

  it('moveDownLine from cursor=0 (col 0, row 0) does NOT land at index 5 (mid-surrogate)', () => {
    const result = InputCore.moveDownLine({ buffer: EMOJI_WRAP, cursor: 0 }, 4, 0);
    expect(result.moved).toBe(true);
    if (result.moved) {
      expect(isMidSurrogate(EMOJI_WRAP, result.state.cursor)).toBe(false);
    }
  });

  it('moveUpLine from cursor=4 (start of second 🙂, row 1) does NOT land at index 2 (mid-surrogate)', () => {
    const result = InputCore.moveUpLine({ buffer: EMOJI_WRAP, cursor: 4 }, 4, 0);
    expect(result.moved).toBe(true);
    if (result.moved) {
      expect(isMidSurrogate(EMOJI_WRAP, result.state.cursor)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Exhaustive sweep: no cursor position should ever produce a mid-surrogate landing.
  // -------------------------------------------------------------------------
  it('no up/down landing is ever mid-surrogate for emoji-wrap buffer (width=4)', () => {
    assertNeverMidSurrogate(EMOJI_WRAP, 4, 0);
  });

  it('no up/down landing is ever mid-surrogate for emoji+CJK multi-line buffer (width=80)', () => {
    // '🙂你\nab' — emoji-cjk-multi golden fixture
    assertNeverMidSurrogate('\u{1F642}\u4f60\nab', 80, 1);
  });

  it('no up/down landing is ever mid-surrogate for mixed long buffer (width=10)', () => {
    // 'The quick 🙂 brown 你好 fox jumps' — long-mixed golden fixture
    assertNeverMidSurrogate('The quick \u{1F642} brown \u4f60\u597d fox jumps', 10, 4);
  });

  it('no up/down landing is ever mid-surrogate with emoji on a single soft-wrapped line', () => {
    // Five emoji on one logical line, narrow terminal
    assertNeverMidSurrogate('\u{1F642}\u{1F642}\u{1F642}\u{1F642}\u{1F642}', 4, 0);
  });
});

// ---------------------------------------------------------------------------
// Word-jump grapheme safety (#4987)
// ---------------------------------------------------------------------------
// wordStartBefore / wordEndAfter previously stepped by UTF-16 code units
// (charAt), which is surrogate-safe but not grapheme-safe. A cursor positioned
// after the high surrogate of an emoji would leave i pointing mid-grapheme.
// These tests FAIL on the unfixed code and PASS after the fix.
// ---------------------------------------------------------------------------

describe('InputCore word-jump grapheme safety (#4987)', () => {
  // 'hello 🙂 world' — emoji is U+1F642 (two UTF-16 code units, indices 6-7)
  // Buffer indices: h=0 e=1 l=2 l=3 o=4 SP=5 🙂=[6,7] SP=8 w=9 o=10 r=11 l=12 d=13
  const BUF = 'hello \u{1F642} world';

  it('deleteWordBackward from after emoji does not split the emoji', () => {
    // Cursor at index 8 (after emoji, before space+world).
    // deleteWordBackward should remove the whole emoji as one grapheme, not
    // split it at the surrogate boundary (index 7).
    const state = { buffer: BUF, cursor: 8 };
    const result = InputCore.deleteWordBackward(state);
    // The emoji must be entirely removed — it must not appear in the remaining buffer.
    expect(result.buffer).not.toContain('\u{1F642}');
    expect(result.buffer).toBe('hello  world');
  });

  it('deleteWordForward from before emoji does not split the emoji', () => {
    // Cursor at index 6 (start of emoji).
    // deleteWordForward should consume the whole emoji as one word (non-whitespace run).
    const state = { buffer: BUF, cursor: 6 };
    const result = InputCore.deleteWordForward(state);
    // The emoji must be entirely removed.
    expect(result.buffer).not.toContain('\u{1F642}');
    expect(result.buffer).toBe('hello  world');
  });

  it('moveWordBackward from after emoji lands at emoji start, not mid-surrogate', () => {
    // Cursor at 8 (after the emoji grapheme). Moving backward over the word
    // (the emoji itself) must land at index 6, not 7 (mid-surrogate).
    const state = { buffer: BUF, cursor: 8 };
    const result = InputCore.moveWordBackward(state);
    expect(result.cursor).toBe(6);
  });

  it('moveWordForward from before emoji lands after emoji, not mid-surrogate', () => {
    // Cursor at 6 (start of emoji). Moving forward over the word must land
    // at index 8 (after full emoji), not 7 (mid-surrogate).
    const state = { buffer: BUF, cursor: 6 };
    const result = InputCore.moveWordForward(state);
    expect(result.cursor).toBe(8);
  });
});
