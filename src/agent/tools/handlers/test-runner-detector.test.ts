/**
 * Unit tests for the test-runner detector.
 *
 * Each test uses a hand-constructed representative output string for the
 * respective runner — no file I/O, no child processes.
 */

import { describe, it, expect } from 'vitest';
import { detectTestResult } from './test-runner-detector.js';

describe('detectTestResult', () => {
  it('returns null for empty string', () => {
    expect(detectTestResult('')).toBeNull();
  });

  it('returns null for non-test output', () => {
    expect(detectTestResult('Hello world\nfoo bar')).toBeNull();
  });

  // ---- vitest -------------------------------------------------------------
  it('vitest: all passing', () => {
    const output = `
 ✓ src/foo.test.ts (3)

 Test Files  1 passed (1)
 Tests  3 passed (3)
 Duration  1.23s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'vitest', passed: 3, failed: 0 });
  });

  it('vitest: some failing', () => {
    const output = `
 × src/bar.test.ts (2)

 Test Files  1 failed (1)
 Tests  3 passed | 2 failed (5)
 Duration  0.98s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'vitest', passed: 3, failed: 2 });
  });

  it('vitest: passing with skipped', () => {
    const output = `
 Test Files  1 passed (1)
 Tests  4 passed | 1 skipped (5)
 Duration  0.45s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'vitest', passed: 4, failed: 0, skipped: 1 });
  });

  // ---- jest ---------------------------------------------------------------
  it('jest: all passing', () => {
    const output = `
PASS src/foo.test.js
  ✓ does a thing (5ms)

Tests:       3 passed, 3 total
Test Suites: 1 passed, 1 total
Time:        0.789s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'jest', passed: 3, failed: 0 });
  });

  it('jest: some failing', () => {
    const output = `
FAIL src/bar.test.js
  ✕ fails (2ms)

Tests:       2 failed, 3 passed, 5 total
Test Suites: 1 failed, 1 total
Time:        1.234s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'jest', passed: 3, failed: 2 });
  });

  // ---- pytest -------------------------------------------------------------
  it('pytest: all passing', () => {
    const output = `
collected 5 items

test_foo.py .....

========================= 5 passed in 0.12s =========================
`.trim();
    const result = detectTestResult(output);
    expect(result?.runner).toBe('pytest');
    expect(result?.passed).toBe(5);
    expect(result?.failed).toBe(0);
  });

  it('pytest: mixed pass and fail', () => {
    const output = `
collected 5 items

test_foo.py ..F..

========================= 2 failed, 3 passed in 0.23s =========================
`.trim();
    const result = detectTestResult(output);
    expect(result?.runner).toBe('pytest');
    expect(result?.passed).toBe(3);
    expect(result?.failed).toBe(2);
  });

  // ---- mocha --------------------------------------------------------------
  it('mocha: all passing', () => {
    const output = `
  my suite
    ✓ does a thing (3ms)
    ✓ does another thing (2ms)

  2 passing (10ms)
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'mocha', passed: 2, failed: 0 });
  });

  it('mocha: with failures', () => {
    const output = `
  my suite
    ✓ passes (2ms)
    ✗ fails

  1 passing (8ms)
  1 failing

  1) my suite fails:
     AssertionError: expected 1 to equal 2
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'mocha', passed: 1, failed: 1 });
  });

  // ---- go test ------------------------------------------------------------
  it('go-test: all passing', () => {
    const output = `
ok      github.com/myorg/myapp/pkg  0.123s
ok      github.com/myorg/myapp/api  0.456s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'go-test', passed: 2, failed: 0 });
  });

  it('go-test: with failure', () => {
    const output = `
ok      github.com/myorg/myapp/pkg  0.123s
FAIL    github.com/myorg/myapp/api  0.456s
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'go-test', passed: 1, failed: 1 });
  });

  // ---- cargo --------------------------------------------------------------
  it('cargo: all passing', () => {
    const output = `
running 5 tests
test foo ... ok
test bar ... ok
test baz ... ok
test qux ... ok
test quux ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'cargo', passed: 5, failed: 0, skipped: 0 });
  });

  it('cargo: with failures', () => {
    const output = `
running 4 tests
test foo ... ok
test bar ... FAILED

test result: FAILED. 1 passed; 1 failed; 0 ignored
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'cargo', passed: 1, failed: 1, skipped: 0 });
  });

  // ---- rspec --------------------------------------------------------------
  it('rspec: all passing', () => {
    const output = `
..........

Finished in 0.00345 seconds (files took 0.123 seconds to load)
10 examples, 0 failures
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'rspec', passed: 10, failed: 0 });
  });

  it('rspec: with failures', () => {
    const output = `
.F...

Finished in 0.01s
5 examples, 2 failures
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'rspec', passed: 3, failed: 2 });
  });

  // ---- phpunit ------------------------------------------------------------
  it('phpunit: all passing', () => {
    const output = `
PHPUnit 9.5.20

.....

Time: 00:00.123, Memory: 8.00 MB

OK (5 tests, 10 assertions)
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'phpunit', passed: 5, failed: 0 });
  });

  it('phpunit: with failures', () => {
    const output = `
PHPUnit 9.5.20

..F..

Time: 00:00.234, Memory: 8.00 MB

FAILURES!
Tests: 5, Assertions: 9, Failures: 2.
`.trim();
    const result = detectTestResult(output);
    expect(result).toEqual({ runner: 'phpunit', passed: 3, failed: 2 });
  });
});
