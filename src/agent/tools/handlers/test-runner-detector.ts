/**
 * Test-runner result detector — pure function, no I/O.
 *
 * Parses the stdout/stderr of common test runners and extracts pass/fail/skip
 * counts. Used by the bash handler to attach structured test metadata to
 * `ToolResult` so consumers (phase reducer, operator dashboard) can react to
 * test outcomes without re-parsing raw output.
 *
 * The function returns `null` when no known runner output is detected — this
 * is the normal case for non-test bash invocations.
 *
 * @module agent/tools/handlers/test-runner-detector
 */

/** A runner variant that we can detect and parse. */
export type Runner =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'mocha'
  | 'go-test'
  | 'cargo'
  | 'rspec'
  | 'phpunit';

/** Structured test result extracted from raw runner output. */
export interface TestResult {
  runner: Runner;
  passed: number;
  failed: number;
  skipped?: number;
}

// ---------------------------------------------------------------------------
// Regex catalogue
//
// Each pattern is designed to match the primary summary line produced by a
// standard run of the respective runner. Patterns are checked in declaration
// order; once a runner is identified (first match) we stop.
//
// Vitest (v1/v2): "Tests  5 passed (5)" or "Tests  3 passed | 2 failed (5)"
//   Also: "Tests  3 passed | 1 failed | 1 skipped (5)"
//   Full line: "Tests  3 passed | 2 failed (5)"
const VITEST_RE =
  /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/;

// Jest (v29): "Tests:       2 failed, 3 passed, 5 total"
//   or:       "Tests:       5 passed, 5 total"
const JEST_RE =
  /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*\d+\s+total/;

// Pytest (v7/v8):
//   "= 3 passed in 0.12s ="
//   "= 2 passed, 1 failed in 0.23s ="
//   "= 1 failed in 0.05s ="
const PYTEST_RE =
  /={3,}\s*(?:(\d+)\s+failed,\s*)?(\d+)\s+passed(?:,\s*(\d+)\s+warning)?.*in\s+[\d.]+s\s*={3,}|={3,}\s*(\d+)\s+passed.*in\s+[\d.]+s\s*={3,}/;

// Mocha:
//   "  3 passing (21ms)"
//   "  1 failing"
const MOCHA_PASS_RE = /(\d+)\s+passing/;
const MOCHA_FAIL_RE = /(\d+)\s+failing/;

// go test:
//   "ok      github.com/foo/bar  0.123s"
//   "FAIL    github.com/foo/bar  0.023s"
// Each line is one package. We tally ok vs FAIL counts as passed/failed.
const GO_TEST_LINE_RE = /^(ok|FAIL)\s+\S+\s+[\d.]+s/gm;

// cargo test:
//   "test result: ok. 5 passed; 0 failed; 1 ignored"
//   "test result: FAILED. 3 passed; 2 failed; 0 ignored"
const CARGO_RE =
  /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/;

// RSpec:
//   "5 examples, 0 failures"
//   "5 examples, 2 failures"
const RSPEC_RE = /(\d+) examples?, (\d+) failures?/;

// PHPUnit:
//   "OK (5 tests, 10 assertions)"
//   "FAILURES!\nTests: 5, Assertions: 10, Failures: 2."
const PHPUNIT_OK_RE = /OK \((\d+) tests?/;
const PHPUNIT_FAIL_RE = /Tests:\s*(\d+)[^]*?Failures:\s*(\d+)/;

// ---------------------------------------------------------------------------

function parseVitest(output: string): TestResult | null {
  const m = output.match(VITEST_RE);
  if (!m) return null;
  const passed = parseInt(m[1] ?? '0', 10);
  const failed = parseInt(m[2] ?? '0', 10);
  const skipped = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
  return { runner: 'vitest', passed, failed, ...(skipped !== undefined ? { skipped } : {}) };
}

function parseJest(output: string): TestResult | null {
  const m = output.match(JEST_RE);
  if (!m) return null;
  const failed = parseInt(m[1] ?? '0', 10);
  const passed = parseInt(m[2] ?? '0', 10);
  return { runner: 'jest', passed, failed };
}

function parsePytest(output: string): TestResult | null {
  // Try general pattern first (handles both pass-only and pass+fail)
  const m = output.match(PYTEST_RE);
  if (!m) return null;

  // Group layout depends on which alternative matched:
  //   Alt 1: m[1]=failed(opt), m[2]=passed, m[3]=warning(opt)
  //   Alt 2: m[4]=passed (pass-only short form)
  if (m[2] !== undefined) {
    const passed = parseInt(m[2], 10);
    const failed = parseInt(m[1] ?? '0', 10);
    return { runner: 'pytest', passed, failed };
  }
  if (m[4] !== undefined) {
    const passed = parseInt(m[4], 10);
    return { runner: 'pytest', passed, failed: 0 };
  }
  return null;
}

function parseMocha(output: string): TestResult | null {
  const passM = output.match(MOCHA_PASS_RE);
  if (!passM) return null;
  const passed = parseInt(passM[1] ?? '0', 10);
  const failM = output.match(MOCHA_FAIL_RE);
  const failed = failM ? parseInt(failM[1] ?? '0', 10) : 0;
  return { runner: 'mocha', passed, failed };
}

function parseGoTest(output: string): TestResult | null {
  const matches = [...output.matchAll(GO_TEST_LINE_RE)];
  if (matches.length === 0) return null;
  let passed = 0;
  let failed = 0;
  for (const m of matches) {
    if (m[1] === 'ok') passed++;
    else if (m[1] === 'FAIL') failed++;
  }
  return { runner: 'go-test', passed, failed };
}

function parseCargo(output: string): TestResult | null {
  const m = output.match(CARGO_RE);
  if (!m) return null;
  const passed = parseInt(m[1] ?? '0', 10);
  const failed = parseInt(m[2] ?? '0', 10);
  const skipped = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
  return { runner: 'cargo', passed, failed, ...(skipped !== undefined ? { skipped } : {}) };
}

function parseRspec(output: string): TestResult | null {
  const m = output.match(RSPEC_RE);
  if (!m) return null;
  const passed = parseInt(m[1] ?? '0', 10);
  const failed = parseInt(m[2] ?? '0', 10);
  // RSpec "passed" count is total examples minus failures.
  return { runner: 'rspec', passed: passed - failed, failed };
}

function parsePhpunit(output: string): TestResult | null {
  const okM = output.match(PHPUNIT_OK_RE);
  if (okM) {
    const passed = parseInt(okM[1] ?? '0', 10);
    return { runner: 'phpunit', passed, failed: 0 };
  }
  const failM = output.match(PHPUNIT_FAIL_RE);
  if (failM) {
    const total = parseInt(failM[1] ?? '0', 10);
    const failed = parseInt(failM[2] ?? '0', 10);
    return { runner: 'phpunit', passed: total - failed, failed };
  }
  return null;
}

/**
 * Attempt to detect a test-runner result summary in `output`.
 *
 * Tries each runner's pattern in order; returns the first successful parse.
 * Returns `null` when the output does not match any known runner.
 *
 * @param output - Raw stdout+stderr string from a bash tool invocation
 *   (after ANSI stripping, before any truncation).
 */
export function detectTestResult(output: string): TestResult | null {
  return (
    parseVitest(output) ??
    parseJest(output) ??
    parsePytest(output) ??
    parseMocha(output) ??
    parseGoTest(output) ??
    parseCargo(output) ??
    parseRspec(output) ??
    parsePhpunit(output) ??
    null
  );
}
