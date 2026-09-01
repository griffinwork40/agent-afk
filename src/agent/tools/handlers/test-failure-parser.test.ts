/**
 * Unit tests for test-failure-parser.ts
 *
 * Each test case supplies a representative sample from a runner's real output
 * and asserts the extracted TestFailure records.
 */

import { describe, it, expect } from 'vitest';
import { parseTestFailures } from './test-failure-parser.js';

// ---------------------------------------------------------------------------
// Vitest
// ---------------------------------------------------------------------------

describe('vitest failure parsing', () => {
  const VITEST_OUTPUT = `
 FAIL  src/foo.test.ts > FooModule > should add numbers
AssertionError: expected 3 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 3

 × should add numbers
   AssertionError: expected 3 to be 4

FAIL  src/bar.test.ts
 × should subtract numbers
   AssertionError: expected 1 to be 2

Tests  0 passed | 2 failed (2)
`;

  it('extracts failures from vitest output', () => {
    const failures = parseTestFailures(VITEST_OUTPUT, 'vitest');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const names = failures.map((f) => f.name);
    expect(names.some((n) => n.includes('should') || n.includes('add') || n.includes('subtract'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Jest
// ---------------------------------------------------------------------------

describe('jest failure parsing', () => {
  const JEST_OUTPUT = `
  ● FooModule › should return correct value

    expect(received).toBe(expected)

    Expected: 42
    Received: 41

      at Object.<anonymous> (src/foo.test.ts:10:25)

  ● BarModule › handles edge case

    TypeError: Cannot read properties of undefined

      at Object.<anonymous> (src/bar.test.ts:22:5)

Tests:       2 failed, 3 passed, 5 total
`;

  it('extracts two jest failures', () => {
    const failures = parseTestFailures(JEST_OUTPUT, 'jest');
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts test name from jest block', () => {
    const failures = parseTestFailures(JEST_OUTPUT, 'jest');
    const names = failures.map((f) => f.name);
    expect(names.some((n) => n.includes('FooModule'))).toBe(true);
  });

  it('extracts file and line from jest stack', () => {
    const failures = parseTestFailures(JEST_OUTPUT, 'jest');
    const withFile = failures.filter((f) => f.file !== undefined);
    expect(withFile.length).toBeGreaterThan(0);
    const f = withFile[0]!;
    expect(f.file).toContain('.ts');
    expect(typeof f.line).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Pytest
// ---------------------------------------------------------------------------

describe('pytest failure parsing', () => {
  const PYTEST_OUTPUT = `
FAILED tests/test_foo.py::test_add_numbers - AssertionError: assert 3 == 4
FAILED tests/test_bar.py::test_subtract - AssertionError: assert 1 == 2

= 0 passed, 2 failed in 0.12s =
`;

  it('extracts two pytest failures', () => {
    const failures = parseTestFailures(PYTEST_OUTPUT, 'pytest');
    expect(failures).toHaveLength(2);
  });

  it('extracts file path from pytest output', () => {
    const failures = parseTestFailures(PYTEST_OUTPUT, 'pytest');
    expect(failures[0]!.file).toBe('tests/test_foo.py');
  });

  it('extracts test name from pytest output', () => {
    const failures = parseTestFailures(PYTEST_OUTPUT, 'pytest');
    expect(failures[0]!.name).toBe('test_add_numbers');
  });

  it('extracts message from pytest output', () => {
    const failures = parseTestFailures(PYTEST_OUTPUT, 'pytest');
    expect(failures[0]!.message).toContain('AssertionError');
  });
});

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

describe('cargo test failure parsing', () => {
  const CARGO_OUTPUT = `
running 3 tests
test math::test_add ... ok
test math::test_subtract ... FAILED
test math::test_multiply ... FAILED

failures:

---- math::test_subtract stdout ----
thread 'math::test_subtract' panicked at 'assertion failed: 3 == 4'

---- math::test_multiply stdout ----
thread 'math::test_multiply' panicked at 'assertion failed: 6 == 7'

test result: FAILED. 1 passed; 2 failed; 0 ignored
`;

  it('extracts two cargo failures', () => {
    const failures = parseTestFailures(CARGO_OUTPUT, 'cargo');
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts test name from cargo FAILED line', () => {
    const failures = parseTestFailures(CARGO_OUTPUT, 'cargo');
    const names = failures.map((f) => f.name);
    expect(names.some((n) => n.includes('test_subtract'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Go test
// ---------------------------------------------------------------------------

describe('go test failure parsing', () => {
  const GO_OUTPUT = `
--- FAIL: TestAdd (0.00s)
    foo_test.go:15: got 3, want 4
--- FAIL: TestSubtract (0.00s)
    foo_test.go:22: got 1, want 2
--- PASS: TestMultiply (0.00s)
FAIL    example.com/mymod    0.012s
`;

  it('extracts two go test failures', () => {
    const failures = parseTestFailures(GO_OUTPUT, 'go-test');
    expect(failures).toHaveLength(2);
  });

  it('extracts test names from go test output', () => {
    const failures = parseTestFailures(GO_OUTPUT, 'go-test');
    expect(failures[0]!.name).toBe('TestAdd');
    expect(failures[1]!.name).toBe('TestSubtract');
  });
});

// ---------------------------------------------------------------------------
// RSpec
// ---------------------------------------------------------------------------

describe('rspec failure parsing', () => {
  const RSPEC_OUTPUT = `
Failures:

  1) Foo#add returns the sum
     Failure/Error: expect(foo.add(1, 2)).to eq(4)
     expected: 4
          got: 3
     # ./spec/foo_spec.rb:12:in 'block (3 levels)'

  2) Foo#subtract handles zero
     Failure/Error: expect(foo.subtract(2, 2)).to eq(1)
     # ./spec/foo_spec.rb:22:in 'block'

5 examples, 2 failures
`;

  it('extracts two rspec failures', () => {
    const failures = parseTestFailures(RSPEC_OUTPUT, 'rspec');
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts test name from rspec output', () => {
    const failures = parseTestFailures(RSPEC_OUTPUT, 'rspec');
    expect(failures[0]!.name).toContain('Foo');
  });
});

// ---------------------------------------------------------------------------
// Unknown runner — graceful empty
// ---------------------------------------------------------------------------

describe('unknown runner', () => {
  it('returns empty array for mocha (no detailed parser)', () => {
    const output = '1 failing\n  Error: expected true to equal false';
    // mocha falls through to default (empty) — no per-failure parser
    const failures = parseTestFailures(output, 'mocha');
    expect(Array.isArray(failures)).toBe(true);
    expect(failures).toHaveLength(0);
  });

  it('returns empty array for phpunit', () => {
    // phpunit not in parser
    const failures = parseTestFailures('FAILURES!\nTests: 3, Failures: 1.', 'phpunit');
    expect(failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty output
// ---------------------------------------------------------------------------

describe('empty / clean output', () => {
  it('returns empty array for empty string', () => {
    expect(parseTestFailures('', 'vitest')).toHaveLength(0);
    expect(parseTestFailures('', 'jest')).toHaveLength(0);
    expect(parseTestFailures('', 'pytest')).toHaveLength(0);
  });

  it('returns empty array for a passing run', () => {
    const passing = 'Tests  5 passed (5)\n';
    expect(parseTestFailures(passing, 'vitest')).toHaveLength(0);
  });
});
