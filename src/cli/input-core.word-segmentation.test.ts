/**
 * Regression test for PR #5137 review: word-jump / word-delete must segment
 * the buffer a bounded number of times per call, not once per grapheme.
 *
 * The #4987 fix made wordStartBefore / wordEndAfter grapheme-safe by calling
 * previousGraphemeIndex / nextGraphemeIndex once per step, and each of those
 * re-segments the whole buffer, so a word of N graphemes cost N full
 * segmentation passes (quadratic). These tests count Intl.Segmenter passes
 * instead of timing, so they are deterministic in CI.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextGraphemeIndex, previousGraphemeIndex } from './display.js';
import { InputCore } from './input-core.js';

const hasSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl;

function countSegmentPasses(run: () => void): number {
  const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  try {
    run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe.runIf(hasSegmenter)('InputCore word ops segment the buffer a bounded number of times', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // One long whitespace-free word (e.g. a pasted token): the old code ran one
  // segmentation pass per grapheme, i.e. ~2000 passes here.
  const LONG = 'x'.repeat(2000);
  const LONG_MIXED = `${'ab\u{1F642}e\u0301'.repeat(400)} tail`;

  it('moveWordBackward over a long word', () => {
    const passes = countSegmentPasses(() => {
      expect(InputCore.moveWordBackward({ buffer: LONG, cursor: LONG.length }).cursor).toBe(0);
    });
    expect(passes).toBeLessThanOrEqual(2);
  });

  it('deleteWordBackward over a long word', () => {
    const passes = countSegmentPasses(() => {
      expect(InputCore.deleteWordBackward({ buffer: LONG, cursor: LONG.length }).buffer).toBe('');
    });
    expect(passes).toBeLessThanOrEqual(2);
  });

  it('moveWordForward over a long word', () => {
    const passes = countSegmentPasses(() => {
      expect(InputCore.moveWordForward({ buffer: LONG, cursor: 0 }).cursor).toBe(LONG.length);
    });
    expect(passes).toBeLessThanOrEqual(2);
  });

  it('deleteWordForward over a long mixed-grapheme word', () => {
    const passes = countSegmentPasses(() => {
      expect(InputCore.deleteWordForward({ buffer: LONG_MIXED, cursor: 0 }).buffer).toBe(' tail');
    });
    expect(passes).toBeLessThanOrEqual(2);
  });
});

// Reference implementation: the per-grapheme walk the PR introduced (correct
// but quadratic). The linear version must agree with it at every cursor.
function refWordStart(buffer: string, cursor: number): number {
  let i = cursor;
  while (i > 0) {
    const prev = previousGraphemeIndex(buffer, i);
    if (!/\s/.test(buffer.slice(prev, i))) break;
    i = prev;
  }
  while (i > 0) {
    const prev = previousGraphemeIndex(buffer, i);
    if (/\s/.test(buffer.slice(prev, i))) break;
    i = prev;
  }
  return i;
}

function refWordEnd(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length) {
    const next = nextGraphemeIndex(buffer, i);
    if (!/\s/.test(buffer.slice(i, next))) break;
    i = next;
  }
  while (i < buffer.length) {
    const next = nextGraphemeIndex(buffer, i);
    if (/\s/.test(buffer.slice(i, next))) break;
    i = next;
  }
  return i;
}

// Regression for #5162: word-boundary loops must not walk k past the ends of
// the offsets array. When the buffer starts with whitespace and the cursor sits
// at the end of that grapheme, wordStartBefore decrements k to -1 without the
// guard; when the buffer ends with whitespace and the cursor is at the start of
// that grapheme, wordEndAfter increments k past offsets.length - 1 without the
// guard. In both cases the coercion of undefined produces the correct answer,
// but the reads are out-of-bounds. The guards make the intent explicit.
describe('InputCore word ops: bounds guards on offsets array (regression #5162)', () => {
  it('moveWordBackward with cursor at end of a leading-whitespace grapheme does not walk k past 0', () => {
    // Buffer: single space then word. Cursor = 1 (end of the space grapheme).
    // wordStartBefore: k starts at 0, first loop decrements to -1 — guard fires.
    const state = { buffer: ' word', cursor: 1 };
    expect(InputCore.moveWordBackward(state).cursor).toBe(0);
  });

  it('moveWordForward with cursor at start of a trailing-whitespace grapheme does not walk k past offsets.length', () => {
    // Buffer: word then single space. Cursor = 4 (start of the trailing space).
    // wordEndAfter: k starts at offsets.length - 1, second loop increments to
    // offsets.length — guard fires.
    const state = { buffer: 'word ', cursor: 4 };
    expect(InputCore.moveWordForward(state).cursor).toBe(5);
  });

  it('deleteWordBackward on a buffer whose only content is whitespace clears it', () => {
    // Exercises the k >= 0 guard: entire buffer is whitespace, cursor at end.
    const state = { buffer: '   ', cursor: 3 };
    expect(InputCore.deleteWordBackward(state)).toEqual({ buffer: '', cursor: 0 });
  });

  it('deleteWordForward on a buffer whose only content is whitespace clears it', () => {
    // Exercises the k < offsets.length guard: entire buffer is whitespace, cursor at start.
    const state = { buffer: '   ', cursor: 0 };
    expect(InputCore.deleteWordForward(state)).toEqual({ buffer: '', cursor: 0 });
  });
});

describe('InputCore word ops match the per-grapheme reference walk', () => {
  const BUFFERS = [
    '',
    ' ',
    'hello \u{1F642} world',
    '  a\u0301b  \u{1F468}\u200D\u{1F469}\u200D\u{1F467}x \n\tq\u{1F1FA}\u{1F1F8}  ',
    'e\u0301\u0301 \u{1F44D}\u{1F3FD}\u{1F44D}  end',
  ];

  for (const buffer of BUFFERS) {
    it(`agrees at every cursor for ${JSON.stringify(buffer)}`, () => {
      // Includes mid-grapheme cursors (e.g. between surrogate halves).
      for (let cursor = 0; cursor <= buffer.length; cursor++) {
        const state = { buffer, cursor };
        expect(InputCore.moveWordBackward(state).cursor).toBe(refWordStart(buffer, cursor));
        expect(InputCore.moveWordForward(state).cursor).toBe(refWordEnd(buffer, cursor));
      }
    });
  }
});
