/**
 * Per-failure detail parser for the `test_run` tool.
 *
 * Extends the summary-level `detectTestResult()` with per-test failure
 * extraction: parses failure blocks from vitest, jest, pytest, cargo, go-test,
 * and rspec output and returns structured `TestFailure` records.
 *
 * Pure function — no I/O, no side-effects.
 *
 * @module agent/tools/handlers/test-failure-parser
 */

import type { Runner } from './test-runner-detector.js';

/** A single test-failure extracted from runner output. */
export interface TestFailure {
  /** Human-readable test name or description. */
  name: string;
  /** Source file, if extractable from output. */
  file?: string;
  /** Line number within the file, if present. */
  line?: number;
  /** Failure/assertion message (first error line). */
  message: string;
  /** Full stack trace or diff body, if present. */
  stack?: string;
}

// ---------------------------------------------------------------------------
// Vitest / Jest
// ---------------------------------------------------------------------------

/**
 * Vitest and Jest both emit FAIL blocks with a similar structure:
 *
 *   ● test name
 *     AssertionError: ...
 *       at ...
 *
 * or (vitest):
 *
 *   FAIL path/to/file.test.ts > test name
 *     AssertionError: ...
 */
function parseVitestJestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // Vitest: "FAIL path/to/file.test.ts" then " > test suite > test name"
  // Jest: "● test name"
  // We match both: capture the block starting at "● " or vitest's FAIL header.

  // Match jest-style "● test name" blocks
  const jestBlockRe = /^\s*●\s+(.+?)\s*$/gm;
  // Match vitest-style "FAIL src/foo.test.ts > test > name" lines
  const vitestFailRe = /^FAIL\s+(.+\.(?:test|spec)\.[jt]sx?)\s*$/gm;

  // Split on lines to find failure blocks
  const lines = output.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Vitest: FAIL <file>
    const vitestM = vitestFailRe.exec(line);
    if (vitestM) {
      const file = vitestM[1]?.trim();
      // Next lines may contain " × test name" or "✕ test name"
      let j = i + 1;
      while (j < lines.length) {
        const tLine = lines[j]!;
        const nameM = /^\s+[×✕✗x]\s+(.+)$/.exec(tLine);
        if (nameM) {
          const name = nameM[1]?.trim() ?? 'unknown';
          // Grab message from subsequent lines
          let msg = '';
          let k = j + 1;
          while (k < lines.length && /^\s+/.test(lines[k]!)) {
            const cleaned = lines[k]!.trim();
            if (cleaned && !cleaned.startsWith('at ')) {
              msg = msg || cleaned;
            }
            k++;
          }
          failures.push({ name, file, message: msg || 'Test failed' });
        } else if (tLine.trim() === '' && j > i + 2) {
          break;
        }
        j++;
      }
      vitestFailRe.lastIndex = 0;
      i++;
      continue;
    }

    // Jest: ● <test name>
    const jestM = jestBlockRe.exec(line);
    if (jestM) {
      const name = jestM[1]?.trim() ?? 'unknown';
      let message = '';
      let stack = '';
      let file: string | undefined;
      let lineNum: number | undefined;

      let j = i + 1;
      while (j < lines.length) {
        const tLine = lines[j]!;
        if (/^\s*●\s+/.test(tLine)) break; // next test
        if (!message && /^\s+(?:expect|assert|Error|AssertionError)/.test(tLine)) {
          message = tLine.trim();
        }
        // at Object.<anonymous> (src/foo.test.ts:12:5)
        if (!file) {
          const atM = /at\s+\S+\s+\((.+?):(\d+):\d+\)/.exec(tLine);
          if (atM) {
            file = atM[1]?.trim();
            lineNum = parseInt(atM[2]!, 10);
          }
        }
        stack += tLine + '\n';
        j++;
      }

      failures.push({
        name,
        ...(file ? { file } : {}),
        ...(lineNum !== undefined ? { line: lineNum } : {}),
        message: message || 'Test failed',
        ...(stack.trim() ? { stack: stack.trim() } : {}),
      });
      jestBlockRe.lastIndex = 0;
      i = j;
      continue;
    }

    jestBlockRe.lastIndex = 0;
    vitestFailRe.lastIndex = 0;
    i++;
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Pytest
// ---------------------------------------------------------------------------

function parsePytestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // Pytest: "FAILED tests/test_foo.py::test_name - AssertionError: ..."
  const pytestLineRe = /^FAILED\s+(.+?)::([^\s-]+)\s*(?:-\s*(.+))?$/gm;
  let m: RegExpExecArray | null;

  while ((m = pytestLineRe.exec(output)) !== null) {
    const file = m[1]?.trim();
    const name = m[2]?.trim() ?? 'unknown';
    const message = m[3]?.trim() ?? 'Test failed';
    failures.push({ name, ...(file ? { file } : {}), message });
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

function parseCargoFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // "test module::test_name ... FAILED"
  const cargoRe = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm;
  let m: RegExpExecArray | null;

  while ((m = cargoRe.exec(output)) !== null) {
    failures.push({ name: m[1] ?? 'unknown', message: 'Test failed' });
  }

  // Also parse "---- module::test_name stdout ----" blocks for messages
  const stdoutBlockRe = /^-{4}\s+(\S+)\s+stdout\s+-{4}$([\s\S]*?)(?=^-{4}|\z)/gm;
  while ((m = stdoutBlockRe.exec(output)) !== null) {
    const name = m[1] ?? 'unknown';
    const body = m[2]?.trim() ?? '';
    const existing = failures.find((f) => f.name === name);
    if (existing && body) {
      existing.message = body.split('\n')[0]?.trim() ?? existing.message;
      existing.stack = body;
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Go test
// ---------------------------------------------------------------------------

function parseGoTestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // "--- FAIL: TestName (0.00s)"
  const goRe = /^---\s+FAIL:\s+(\S+)\s+\([\d.]+s\)/gm;
  let m: RegExpExecArray | null;

  while ((m = goRe.exec(output)) !== null) {
    failures.push({ name: m[1] ?? 'unknown', message: 'Test failed' });
  }

  return failures;
}

// ---------------------------------------------------------------------------
// RSpec
// ---------------------------------------------------------------------------

function parseRspecFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // "  1) Foo bar"  followed by "     Failure/Error: ..."
  const rspecBlockRe = /^\s+\d+\)\s+(.+?)\s*$/gm;
  const lines = output.split('\n');
  let i = 0;

  while (i < lines.length) {
    const m = rspecBlockRe.exec(lines[i]!);
    if (m) {
      const name = m[1]?.trim() ?? 'unknown';
      let message = '';
      let file: string | undefined;
      let lineNum: number | undefined;

      let j = i + 1;
      while (j < lines.length) {
        const tLine = lines[j]!;
        if (/^\s+\d+\)\s/.test(tLine)) break;
        if (!message && /Failure\/Error/.test(tLine)) {
          message = tLine.replace(/Failure\/Error:\s*/, '').trim();
        }
        // "# ./spec/foo_spec.rb:12:in ..."
        if (!file) {
          const locM = /# (\.\/spec\/.+\.rb):(\d+)/.exec(tLine);
          if (locM) {
            file = locM[1]!;
            lineNum = parseInt(locM[2]!, 10);
          }
        }
        j++;
      }

      failures.push({
        name,
        ...(file ? { file } : {}),
        ...(lineNum !== undefined ? { line: lineNum } : {}),
        message: message || 'Test failed',
      });
      rspecBlockRe.lastIndex = 0;
      i = j;
      continue;
    }
    rspecBlockRe.lastIndex = 0;
    i++;
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse per-failure details from raw test-runner output.
 *
 * @param output - Combined stdout+stderr from the test run (ANSI-stripped).
 * @param runner - Runner variant (from `TestResult.runner`).
 * @returns Array of structured failure records (empty when none found).
 */
export function parseTestFailures(output: string, runner: Runner): TestFailure[] {
  switch (runner) {
    case 'vitest':
    case 'jest':
      return parseVitestJestFailures(output);
    case 'pytest':
      return parsePytestFailures(output);
    case 'cargo':
      return parseCargoFailures(output);
    case 'go-test':
      return parseGoTestFailures(output);
    case 'rspec':
      return parseRspecFailures(output);
    default:
      return [];
  }
}
