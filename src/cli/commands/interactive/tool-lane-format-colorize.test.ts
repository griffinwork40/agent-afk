import { describe, it, expect, beforeAll } from 'vitest';
import { colorizePreviewLine } from './tool-lane-format-colorize.js';
import chalk from 'chalk';
import { stripAnsi } from '../../display.js';

// Force chalk colors for deterministic assertions.
beforeAll(() => { chalk.level = 3; });

/** Helpers: check for specific ANSI SGR codes in output. */
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

function hasGreen(s: string): boolean { return s.includes(GREEN); }
function hasRed(s: string): boolean { return s.includes(RED); }
function hasYellow(s: string): boolean { return s.includes(YELLOW); }
function hasDim(s: string): boolean { return s.includes(DIM); }

/* ================================================================== */
/*  git diff --stat                                                   */
/* ================================================================== */

describe('git diff --stat', () => {
  it('colors + green and - red in a mixed bar graph', () => {
    const result = colorizePreviewLine('  src/foo.ts | 10 ++++------')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
    expect(hasRed(result)).toBe(true);
  });

  it('colors a line with only additions', () => {
    const result = colorizePreviewLine('  src/new.ts | 5 +++++')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
    expect(hasRed(result)).toBe(false);
  });

  it('colors a line with only deletions', () => {
    const result = colorizePreviewLine('  src/old.ts | 3 ---')!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
    expect(hasGreen(result)).toBe(false);
  });

  it('handles ellipsized paths from git', () => {
    const result = colorizePreviewLine('  .../interactive/tool-lane.test.ts | 4 ++--')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
    expect(hasRed(result)).toBe(true);
  });

  it('colors insertions green and deletions red in summary', () => {
    const result = colorizePreviewLine(' 8 files changed, 44 insertions(+), 28 deletions(-)')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
    expect(hasRed(result)).toBe(true);
  });

  it('handles insertions-only summary', () => {
    const result = colorizePreviewLine(' 1 file changed, 2 insertions(+)')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
    expect(hasRed(result)).toBe(false);
  });

  it('handles deletions-only summary', () => {
    const result = colorizePreviewLine(' 3 files changed, 10 deletions(-)')!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
    expect(hasGreen(result)).toBe(false);
  });

  it('handles singular "1 insertion(+)"', () => {
    const result = colorizePreviewLine(' 1 file changed, 1 insertion(+)')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
  });
});

/* ================================================================== */
/*  Test runner output                                                */
/* ================================================================== */

describe('test runner output', () => {
  describe('vitest file-level', () => {
    it('colors ✓ pass lines green', () => {
      const result = colorizePreviewLine('✓ src/cli/palette.test.ts (42 tests) 12ms')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
      expect(hasRed(result)).toBe(false);
    });

    it('colors × fail lines red', () => {
      const result = colorizePreviewLine('× src/cli/palette.test.ts (3 failed) 892ms')!;
      expect(result).not.toBeNull();
      expect(hasRed(result)).toBe(true);
      expect(hasGreen(result)).toBe(false);
    });

    it('colors ✓ pass lines with leading whitespace green', () => {
      // sanitizeLabel trims in production; the regex must also handle
      // untrimmed input so direct callers are not surprised.
      const result = colorizePreviewLine(' ✓ src/cli/palette.test.ts (42 tests) 12ms')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
      expect(hasRed(result)).toBe(false);
    });

    it('colors × fail lines with leading whitespace red', () => {
      const result = colorizePreviewLine(' × src/cli/palette.test.ts (3 failed)')!;
      expect(result).not.toBeNull();
      expect(hasRed(result)).toBe(true);
      expect(hasGreen(result)).toBe(false);
    });
  });

  describe('jest file-level', () => {
    it('colors PASS green', () => {
      const result = colorizePreviewLine('PASS src/cli/palette.test.ts')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
    });

    it('colors FAIL red', () => {
      const result = colorizePreviewLine('FAIL src/cli/palette.test.ts')!;
      expect(result).not.toBeNull();
      expect(hasRed(result)).toBe(true);
    });
  });

  describe('test summary', () => {
    it('colors pass count green and fail count red', () => {
      const result = colorizePreviewLine('Tests  3 failed | 147 passed (150)')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
      expect(hasRed(result)).toBe(true);
    });

    it('colors pass-only summary green', () => {
      const result = colorizePreviewLine('Tests  42 passed (42)')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
      expect(hasRed(result)).toBe(false);
    });

    it('handles "Test Files" variant', () => {
      const result = colorizePreviewLine('Test Files  1 passed (1)')!;
      expect(result).not.toBeNull();
      expect(hasGreen(result)).toBe(true);
    });

    it('handles fail-only summary', () => {
      const result = colorizePreviewLine('Tests  5 failed (5)')!;
      expect(result).not.toBeNull();
      expect(hasRed(result)).toBe(true);
      expect(hasGreen(result)).toBe(false);
    });
  });
});

/* ================================================================== */
/*  TypeScript compiler diagnostics                                   */
/* ================================================================== */

describe('tsc diagnostics', () => {
  it('colors error lines with red diagnostic', () => {
    const line = "src/cli/palette.ts(82,15): error TS2345: Argument of type 'string' is not assignable";
    const result = colorizePreviewLine(line)!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
    // The file path portion should be dim.
    expect(hasDim(result)).toBe(true);
  });

  it('colors warning lines with yellow diagnostic', () => {
    const line = 'src/cli/palette.ts(82,15): warning TS6133: declared but never read';
    const result = colorizePreviewLine(line)!;
    expect(result).not.toBeNull();
    expect(hasYellow(result)).toBe(true);
    expect(hasDim(result)).toBe(true);
  });

  it('colors tsx file errors', () => {
    const line = 'src/components/App.tsx(12,5): error TS2322: Type mismatch';
    const result = colorizePreviewLine(line)!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
  });

  it('colors "Found 0 errors" green', () => {
    const result = colorizePreviewLine('Found 0 errors.')!;
    expect(result).not.toBeNull();
    expect(hasGreen(result)).toBe(true);
  });

  it('colors "Found N errors" red when N > 0', () => {
    const result = colorizePreviewLine('Found 3 errors in 2 files.')!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
  });

  it('colors singular "Found 1 error" red', () => {
    const result = colorizePreviewLine('Found 1 error.')!;
    expect(result).not.toBeNull();
    expect(hasRed(result)).toBe(true);
  });
});

/* ================================================================== */
/*  Non-matching lines                                                */
/* ================================================================== */

describe('non-matching lines', () => {
  it('returns null for plain text', () => {
    expect(colorizePreviewLine('Hello world')).toBeNull();
  });

  it('returns null for a git log line', () => {
    expect(colorizePreviewLine('[main abc1234] fix: something')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(colorizePreviewLine('')).toBeNull();
  });

  it('returns null for a generic file path', () => {
    expect(colorizePreviewLine('src/cli/palette.ts')).toBeNull();
  });

  it('returns null for a JSON object line', () => {
    expect(colorizePreviewLine('{ "name": "agent-afk" }')).toBeNull();
  });
});

/* ================================================================== */
/*  Colorized lines do NOT include the indent (caller's responsibility) */
/* ================================================================== */

describe('no-indent invariant', () => {
  // colorizePreviewLine now returns CONTENT only — the 4-space indent / error
  // gutter is prepended by the caller (tool-lane-format.ts contPrefix) so
  // the correct gutter tone is applied regardless of which pattern matched.
  const cases = [
    '  src/foo.ts | 10 ++++------',
    ' 8 files changed, 44 insertions(+), 28 deletions(-)',
    '✓ src/cli/palette.test.ts (42 tests) 12ms',
    '× src/cli/palette.test.ts (3 failed)',
    'PASS src/cli/palette.test.ts',
    'Tests  42 passed (42)',
    "src/cli/palette.ts(82,15): error TS2345: bad type",
    'Found 0 errors.',
  ];

  for (const line of cases) {
    it(`no leading 4-space indent: ${line.slice(0, 50)}`, () => {
      const result = colorizePreviewLine(line)!;
      expect(result).not.toBeNull();
      // The plain-text content must NOT start with a 4-space indent —
      // the caller owns indentation. ANSI codes may precede content, so
      // strip before checking.
      expect(stripAnsi(result).startsWith('    ')).toBe(false);
    });
  }
});
