import { describe, it, expect, afterEach } from 'vitest';
import {
  capToMeasure,
  resolveTextMeasure,
  DEFAULT_TEXT_MEASURE,
  MIN_TEXT_MEASURE,
} from './measure.js';
import { calculateContentWidth } from '../markdown-stream-format.js';
import { formatThinkingParagraph } from '../commands/interactive/thinking-paragraph.js';
import {
  renderTextChildLines,
  UNICODE_GLYPHS,
} from '../commands/interactive/tool-lane-render.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Run `fn` with `AFK_TEXT_MEASURE` set (or cleared), restoring it after. */
function withMeasureEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env['AFK_TEXT_MEASURE'];
  if (value === undefined) delete process.env['AFK_TEXT_MEASURE'];
  else process.env['AFK_TEXT_MEASURE'] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['AFK_TEXT_MEASURE'];
    else process.env['AFK_TEXT_MEASURE'] = prev;
  }
}

/** Run `fn` with `process.stdout.columns` pinned, restoring it after. */
function withCols<T>(cols: number, fn: () => T): T {
  const prev = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
  }
}

afterEach(() => {
  delete process.env['AFK_TEXT_MEASURE'];
});

describe('resolveTextMeasure', () => {
  it('defaults to DEFAULT_TEXT_MEASURE when unset', () => {
    withMeasureEnv(undefined, () => {
      expect(resolveTextMeasure()).toBe(DEFAULT_TEXT_MEASURE);
    });
  });

  it('defaults when set to empty/whitespace', () => {
    withMeasureEnv('   ', () => expect(resolveTextMeasure()).toBe(DEFAULT_TEXT_MEASURE));
  });

  it.each(['full', 'off', 'none', '0', 'FULL', 'Off'])('disables capping for %s', (v) => {
    withMeasureEnv(v, () => expect(resolveTextMeasure()).toBeNull());
  });

  it('honors an explicit positive integer', () => {
    withMeasureEnv('72', () => expect(resolveTextMeasure()).toBe(72));
  });

  it('falls back to the default below the floor', () => {
    withMeasureEnv(String(MIN_TEXT_MEASURE - 1), () =>
      expect(resolveTextMeasure()).toBe(DEFAULT_TEXT_MEASURE),
    );
  });

  it.each(['wide-please', '20px', '20.5', '20e9'])(
    'falls back to the default on malformed input %s',
    (value) => {
      withMeasureEnv(value, () => expect(resolveTextMeasure()).toBe(DEFAULT_TEXT_MEASURE));
    },
  );
});

describe('capToMeasure', () => {
  it('is a no-op at or below the measure (narrow terminals unaffected)', () => {
    withMeasureEnv(undefined, () => {
      expect(capToMeasure(80)).toBe(80);
      expect(capToMeasure(DEFAULT_TEXT_MEASURE)).toBe(DEFAULT_TEXT_MEASURE);
    });
  });

  it('clamps above the measure', () => {
    withMeasureEnv(undefined, () => {
      expect(capToMeasure(240)).toBe(DEFAULT_TEXT_MEASURE);
    });
  });

  it('never widens a narrow width', () => {
    withMeasureEnv('200', () => expect(capToMeasure(40)).toBe(40));
  });

  it('returns the raw width when capping is disabled', () => {
    withMeasureEnv('full', () => expect(capToMeasure(240)).toBe(240));
  });
});

describe('calculateContentWidth', () => {
  it('caps prose on a wide terminal', () => {
    withMeasureEnv(undefined, () =>
      withCols(200, () => {
        expect(calculateContentWidth(2)).toBe(DEFAULT_TEXT_MEASURE);
      }),
    );
  });

  it('leaves a narrow terminal untouched', () => {
    withMeasureEnv(undefined, () =>
      withCols(80, () => {
        // 80 - 2 (margin) - 2 (indent) = 76, well under the measure.
        expect(calculateContentWidth(2)).toBe(76);
      }),
    );
  });

  it('restores full-width wrapping when disabled', () => {
    withMeasureEnv('full', () =>
      withCols(200, () => {
        expect(calculateContentWidth(2)).toBe(196);
      }),
    );
  });
});

// Invariant: every UNBORDERED text surface shares one measure. Capping a
// subset produces a right-edge discontinuity on wide terminals — bordered
// elements may differ because the border explains the change, but adjacent
// unbordered blocks stopping at different columns read as broken wrapping.
// These cases pin that all three unbordered surfaces stay bounded by the
// measure (plus their own small chrome) rather than scaling with the
// terminal. A new unbordered surface that skips capToMeasure fails here.
describe('adjacency — unbordered surfaces share a right edge', () => {
  const LONG = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '.repeat(12);
  const CHROME_SLACK = 12; // indent + prefix + spine glyph budget

  for (const cols of [120, 200]) {
    it(`bounds prose, thinking, and tool-lane text at ${cols} cols`, () => {
      withMeasureEnv(undefined, () =>
        withCols(cols, () => {
          const proseWidth = calculateContentWidth(2);

          const thinking = formatThinkingParagraph(LONG, { cols, maxLines: 4 });
          const thinkingMax = Math.max(
            ...stripAnsi(thinking)
              .split('\n')
              .map((l) => l.length),
          );

          const laneLines = renderTextChildLines(LONG, '  ', UNICODE_GLYPHS);
          const laneMax = Math.max(...laneLines.map((l) => stripAnsi(l).length));

          const ceiling = DEFAULT_TEXT_MEASURE + CHROME_SLACK;
          expect(proseWidth).toBeLessThanOrEqual(ceiling);
          expect(thinkingMax).toBeLessThanOrEqual(ceiling);
          expect(laneMax).toBeLessThanOrEqual(ceiling);

          // And crucially: they do not scale with the terminal.
          if (cols > ceiling) {
            expect(proseWidth).toBeLessThan(cols);
            expect(thinkingMax).toBeLessThan(cols);
            expect(laneMax).toBeLessThan(cols);
          }
        }),
      );
    });
  }

  it('still fills a narrow terminal (no artificial shrink at 80 cols)', () => {
    withMeasureEnv(undefined, () =>
      withCols(80, () => {
        const laneLines = renderTextChildLines(LONG, '  ', UNICODE_GLYPHS);
        const laneMax = Math.max(...laneLines.map((l) => stripAnsi(l).length));
        // Uses most of the available width rather than being clamped down.
        expect(laneMax).toBeGreaterThan(60);
      }),
    );
  });
});
