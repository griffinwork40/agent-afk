/**
 * Semantic colorizing for bash tailPreview lines.
 *
 * The bash tool spawns commands without a PTY (stdio: pipe), so most CLI
 * tools suppress their own ANSI color. stripEscapeSequences then removes
 * any residual ANSI before content reaches the display layer. This module
 * re-applies semantic color to recognizable plain-text patterns using
 * palette roles, so the visual language stays consistent with the rest of
 * the REPL.
 *
 * Supported pattern families:
 *   - git diff --stat   (`++++----` bar graphs, summary lines)
 *   - Test runners       (vitest ✓/×, jest PASS/FAIL, summary counts)
 *   - TypeScript errors  (`file.ts(line,col): error TS####:`)
 *
 * Called from formatOutcome's tailPreview loop (tool-lane-format.ts).
 *
 * Invariant: all patterns operate on PLAIN TEXT. Input has already passed
 * through sanitizeLabel (which internally runs stripAnsi + control-char scrub)
 * before reaching this module.
 */

import { palette } from '../../palette.js';

/* ------------------------------------------------------------------ */
/*  Entry point                                                       */
/* ------------------------------------------------------------------ */

/**
 * Try to colorize a single tailPreview line. Returns the colorized CONTENT
 * (without any indentation prefix) or `null` when no pattern matches,
 * letting the caller fall back to default dim rendering.
 *
 * Indent/gutter prefix is now the caller's responsibility: the caller in
 * tool-lane-format.ts always prepends `contPrefix` (error gutter + 3 spaces
 * for errored chunks, or 4 plain spaces for success) so the correct gutter
 * tone is applied regardless of which pattern matched.
 */
export function colorizePreviewLine(line: string): string | null {
  return colorizeGitStat(line)
    ?? colorizeTestRunner(line)
    ?? colorizeTscDiagnostic(line);
}

/* ------------------------------------------------------------------ */
/*  git diff --stat                                                   */
/* ------------------------------------------------------------------ */

// File-stat: `  src/foo.ts | 10 ++++----`
// Use [^|]+ instead of \S+.* to avoid greedy backtracking on `|`-dense input
// and to anchor deterministically to the first `|` (filenames may contain `|`
// on macOS/Linux, but git stat never emits them — the fix is a precaution).
const FILE_STAT_RE = /^(\s*[^|]+\|\s*\d+\s+)([+-]+)$/;
// Summary: `8 files changed, 44 insertions(+), 28 deletions(-)`
const DIFF_SUMMARY_RE = /^\s*\d+ files? changed/;

function colorizeGitStat(line: string): string | null {
  const fileMatch = FILE_STAT_RE.exec(line);
  if (fileMatch) {
    const prefix = fileMatch[1]!;
    const bar = fileMatch[2]!;
    return palette.dim(prefix) + colorizeBarGraph(bar);
  }
  if (DIFF_SUMMARY_RE.test(line)) {
    return colorizeDiffSummary(line);
  }
  return null;
}

function colorizeBarGraph(bar: string): string {
  let result = '';
  let i = 0;
  while (i < bar.length) {
    const ch = bar[i]!;
    let run = ch;
    let j = i + 1;
    while (j < bar.length && bar[j] === ch) {
      run += ch;
      j++;
    }
    result += ch === '+' ? palette.diffAdd(run) : palette.diffRemove(run);
    i = j;
  }
  return result;
}

function colorizeDiffSummary(line: string): string {
  // sanitizeLabel .trim()s upstream, but guard defensively in case the call
  // path changes.
  line = line.trimStart();
  let result = line;
  result = result.replace(
    /(\d+) (insertions?\(\+\))/,
    (_, count: string, word: string) => palette.diffAdd(`${count} ${word}`),
  );
  result = result.replace(
    /(\d+) (deletions?\(-\))/,
    (_, count: string, word: string) => palette.diffRemove(`${count} ${word}`),
  );
  return result;
}

/* ------------------------------------------------------------------ */
/*  Test runner output (vitest, jest, generic)                        */
/* ------------------------------------------------------------------ */

// Vitest file-level pass: `✓ src/cli/palette.test.ts (42 tests) 12ms`
// Leading whitespace is optional: sanitizeLabel .trim()s in production, but
// tests and future callers may pass pre-trimmed or untrimmed input.
const VITEST_PASS_RE = /^(\s*✓ .+)/;
// Vitest file-level fail: `× src/cli/palette.test.ts (3 failed) 12ms`
const VITEST_FAIL_RE = /^(\s*× .+)/;
// Jest file-level: `PASS src/foo.test.ts` / `FAIL src/foo.test.ts`
const JEST_PASS_RE = /^(PASS\s+.+)/;
const JEST_FAIL_RE = /^(FAIL\s+.+)/;

// Vitest/jest summary: `Tests  3 failed | 147 passed (150)`
// Also matches: `Test Files  1 passed (1)`
// The pattern captures `N failed` and `N passed` segments for coloring.
// Require plural `Tests` (not singular `Test`) to avoid matching generic bash
// lines like "Test failed with error code 1" that start with "Test ".
const TEST_SUMMARY_RE = /^\s*(Tests|Test Files)\s+/;

function colorizeTestRunner(line: string): string | null {
  // Pass/fail — VITEST_PASS_RE / VITEST_FAIL_RE accept optional leading
  // whitespace, so they cover both file-level and indented body-level output.
  if (VITEST_PASS_RE.test(line)) {
    return palette.success(line);
  }
  if (VITEST_FAIL_RE.test(line)) {
    return palette.error(line);
  }
  if (JEST_PASS_RE.test(line)) {
    return palette.success(line);
  }
  if (JEST_FAIL_RE.test(line)) {
    return palette.error(line);
  }

  // Summary line: color the pass/fail counts independently.
  if (TEST_SUMMARY_RE.test(line)) {
    return colorizeTestSummary(line);
  }

  return null;
}

/**
 * Colorize a test summary line. Each `N failed` segment gets red, each
 * `N passed` segment gets green, everything else stays dim.
 *
 * Input:  `Tests  3 failed | 147 passed (150)`
 * Output: dim(`    Tests  `) + red(`3 failed`) + dim(` | `) +
 *         green(`147 passed`) + dim(` (150)`)
 */
function colorizeTestSummary(line: string): string {
  // sanitizeLabel .trim()s upstream, but guard defensively.
  line = line.trimStart();
  let result = line;
  result = result.replace(
    /(\d+) (failed)/g,
    (_, count: string, word: string) => palette.error(`${count} ${word}`),
  );
  result = result.replace(
    /(\d+) (passed)/g,
    (_, count: string, word: string) => palette.success(`${count} ${word}`),
  );
  return result;
}

/* ------------------------------------------------------------------ */
/*  TypeScript compiler diagnostics (tsc --noEmit / tsc build)        */
/* ------------------------------------------------------------------ */

// Error line: `src/cli/palette.ts(82,15): error TS2345: Argument...`
const TSC_ERROR_RE = /^(.+\.tsx?\(\d+,\d+\): )(error TS\d+: .+)$/;
// Warning line: `src/cli/palette.ts(82,15): warning TS6133: ...`
const TSC_WARNING_RE = /^(.+\.tsx?\(\d+,\d+\): )(warning TS\d+: .+)$/;
// Summary with errors: `Found 3 errors in 2 files.`
const TSC_FOUND_ERRORS_RE = /^Found (\d+) errors?/;
// Clean summary: `Found 0 errors.` (tsc exits 0 with this)
// Covered by TSC_FOUND_ERRORS_RE — the count distinguishes them.

function colorizeTscDiagnostic(line: string): string | null {
  // Error line: dim path + red diagnostic.
  const errMatch = TSC_ERROR_RE.exec(line);
  if (errMatch) {
    return palette.dim(errMatch[1]!) + palette.error(errMatch[2]!);
  }

  // Warning line: dim path + yellow diagnostic.
  const warnMatch = TSC_WARNING_RE.exec(line);
  if (warnMatch) {
    return palette.dim(warnMatch[1]!) + palette.warning(warnMatch[2]!);
  }

  // Summary: `Found N errors`.
  const foundMatch = TSC_FOUND_ERRORS_RE.exec(line);
  if (foundMatch) {
    const count = Number.parseInt(foundMatch[1]!, 10);
    if (count === 0) {
      return palette.success(line);
    }
    return palette.error(line);
  }

  return null;
}
