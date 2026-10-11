import { describe, it, expect } from 'vitest';
import {
  STRATEGY_NUDGE_THRESHOLD,
  STRATEGY_NUDGE_WINDOW,
  StrategyNudger,
  applyStrategyNudge,
  errorSignature,
  findErrorLine,
  normalizeErrorLine,
} from './strategy-nudge.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { InMemoryTraceWriter } from '../trace/writer.js';

const ABORT = new AbortController().signal;
let seq = 0;

function call(name = 'bash', command?: string): ToolCall {
  seq += 1;
  return { id: `c${seq}`, name, input: { command: command ?? `attempt ${seq}` }, signal: ABORT };
}

function bashFail(body: string, code = 1): ToolResult {
  return { content: `Command exited with code ${code}\n${body}`, isError: true };
}

/**
 * Build a test_run content string matching the real handler format (test-run.ts:326-331).
 * passed/failed counts go in the summary; errorMsg is the first bullet (the real error line).
 */
function testRunFail(opts: { passed: number; failed: number; errorMsg: string; testName?: string }): ToolResult {
  const { passed, failed, errorMsg, testName = 'MyTest (src/x.test.ts:1)' } = opts;
  const content =
    `❌ vitest: ${passed} passed | ${failed} failed — 123ms\n` +
    `Command: pnpm test src/x.test.ts\n` +
    `\nFailed tests:\n` +
    `  • ${testName}: ${errorMsg}\n` +
    `\nRAW OUTPUT`;
  return { content, isError: true };
}

const ok: ToolResult = { content: 'ok' };

describe('findErrorLine', () => {
  it('skips the generic bash exit header and picks the real error line', () => {
    const content = 'Command exited with code 1\n> build\nError: Cannot find module "zod"\n    at foo (x.js:1:1)';
    expect(findErrorLine(content)).toBe('Error: Cannot find module "zod"');
  });

  it('matches error words inside identifiers such as AssertionError', () => {
    expect(findErrorLine('FAIL src/a.test.ts\nAssertionError: expected 1 to be 2')).toBe(
      'AssertionError: expected 1 to be 2',
    );
  });

  it('returns null when only generic or non-error lines exist', () => {
    expect(findErrorLine('Command exited with code 1\nhello\nworld')).toBeNull();
    expect(findErrorLine('npm ERR! code 1\nnpm ERR! A complete log of this run')).toBeNull();
    expect(findErrorLine('error Command failed with exit code 2.')).toBeNull();
  });

  it('strips ANSI color codes', () => {
    expect(findErrorLine('\x1b[31mTypeError: x is not a function\x1b[0m')).toBe('TypeError: x is not a function');
  });

  it('skips the test_run summary line, Command line, and Failed tests header', () => {
    const content =
      '❌ vitest: 0 passed | 1 failed — 42ms\n' +
      'Command: pnpm test src/foo.test.ts\n' +
      '\nFailed tests:\n' +
      '  • handlesMissingToken (src/foo.test.ts:10): AssertionError: expected null to be "tok"\n' +
      '\nRAW OUTPUT';
    expect(findErrorLine(content)).toBe(
      '• handlesMissingToken (src/foo.test.ts:10): AssertionError: expected null to be "tok"',
    );
  });

  it('does not skip non-header lines containing "failed" (real error lines)', () => {
    const content = 'TypeError: failed to parse response from server';
    expect(findErrorLine(content)).toBe('TypeError: failed to parse response from server');
  });
});

describe('normalizeErrorLine', () => {
  it('treats the same error with different paths, hashes, and durations as one signature', () => {
    const a = normalizeErrorLine('Error: ENOENT: no such file, open /tmp/afk-abc/src/a.ts:12:4 (31ms) deadbeef12');
    const b = normalizeErrorLine('Error: ENOENT: no such file, open ./other/dir/b.ts (5 s) 0123abcd99');
    expect(a).toBe(b);
  });

  it('keeps small numbers so different assertion failures stay distinct', () => {
    expect(normalizeErrorLine('expected 1 to be 2')).not.toBe(normalizeErrorLine('expected 3 to be 4'));
  });

  it('collapses long numbers such as ports and pids', () => {
    expect(normalizeErrorLine('connect ECONNREFUSED 127.0.0.1:54321')).toBe(
      normalizeErrorLine('connect ECONNREFUSED 127.0.0.1:61234'),
    );
  });

  it('keeps quoted scoped module specifiers distinct', () => {
    const a = normalizeErrorLine("Cannot find module '@prisma/client'");
    const b = normalizeErrorLine("Cannot find module '@tanstack/react-query'");
    expect(a).not.toBe(b);
  });

  it('keeps quoted relative module specifiers distinct', () => {
    const a = normalizeErrorLine("Cannot find module './auth'");
    const b = normalizeErrorLine("Cannot find module './config'");
    expect(a).not.toBe(b);
  });

  it('collapses quoted absolute paths just like unquoted ones', () => {
    const a = normalizeErrorLine("ENOENT: no such file '/tmp/afk-abc/src/x.ts'");
    const b = normalizeErrorLine("ENOENT: no such file '/tmp/afk-xyz/src/y.ts'");
    expect(a).toBe(b);
  });

  it('keeps quoted bare subpath specifiers distinct (lodash/fp vs react-dom/client)', () => {
    const a = normalizeErrorLine("Cannot find module 'lodash/fp'");
    const b = normalizeErrorLine("Cannot find module 'react-dom/client'");
    expect(a).not.toBe(b);
  });

  // perf regression test — 100K-char slash-free run must complete fast
  it('completes quickly on a 100K-char slash-free error line (O(n^2) path-collapse regression)', () => {
    const line = 'Error: ' + 'a'.repeat(100_000);
    const start = Date.now();
    const sig = normalizeErrorLine(line);
    const elapsed = Date.now() - start;
    // Signature must still be produced (non-empty)
    expect(sig.length).toBeGreaterThan(0);
    // Must complete well under 200ms even on slow CI / Windows runners
    expect(elapsed).toBeLessThan(200);
  });

  // NUL-collision regression test
  it('treats lines that differ only by a real NUL as distinct from each other', () => {
    // Without stripping NUL, 'thing \x00p0\x00 failed' collides with the first
    // placeholder token and would be restored as the quoted token from the other line.
    // Both lines carry a quoted token, so protected_[0] exists and an unstripped
    // literal \x00p0\x00 would be restored to it, collapsing the two signatures.
    const withNul = normalizeErrorLine("thing \x00p0\x00 failed for './x'");
    const withPath = normalizeErrorLine("thing './x' failed for './x'");
    expect(withNul).not.toBe(withPath);
  });
});

describe('errorSignature', () => {
  it('returns null for successes and excluded failure classes', () => {
    expect(errorSignature(ok)).toBeNull();
    expect(errorSignature({ content: 'TypeError: boom happened here', isError: true, failureClass: 'abort' })).toBeNull();
    expect(
      errorSignature({ content: 'Error: timed out waiting for it', isError: true, failureClass: 'timeout' }),
    ).toBeNull();
    expect(
      errorSignature({ content: 'Repeat-failure guard: error', isError: true, failureClass: 'repeat-failure' }),
    ).toBeNull();
  });

  it('returns null when the normalized signature is too short to be specific', () => {
    expect(errorSignature(bashFail('Error: /a/b/c'))).toBeNull();
  });
});

describe('StrategyNudger', () => {
  const failure = () => bashFail('Error: Cannot find module "zod" from /repo/src/x.ts');

  it('fires on the second occurrence of the same error even when the calls differ', () => {
    const n = new StrategyNudger();
    expect(n.observe(call('bash', 'pnpm build'), failure())).toBeNull();
    const v = n.observe(call('bash', 'pnpm build --force'), failure());
    expect(STRATEGY_NUDGE_THRESHOLD).toBe(2);
    expect(v).not.toBeNull();
    expect(v!.distinctCalls).toBe(true);
    expect(v!.occurrences).toBe(2);
    expect(v!.notice).toContain('[strategy-nudge]');
    expect(v!.notice).toContain('even though the attempts differed');
    expect(v!.notice).toContain('Cannot find module');
  });

  it('reports distinctCalls=false for a verbatim retry', () => {
    const n = new StrategyNudger();
    n.observe(call('bash', 'pnpm build'), failure());
    const v = n.observe(call('bash', 'pnpm build'), failure());
    expect(v!.distinctCalls).toBe(false);
    expect(v!.notice).not.toContain('even though');
  });

  it('fires at most once per signature', () => {
    const n = new StrategyNudger();
    n.observe(call(), failure());
    expect(n.observe(call(), failure())).not.toBeNull();
    expect(n.observe(call(), failure())).toBeNull();
    expect(n.observe(call(), failure())).toBeNull();
  });

  it('does not fire for different errors', () => {
    const n = new StrategyNudger();
    n.observe(call(), bashFail('TypeError: a is not a function'));
    expect(n.observe(call(), bashFail('ReferenceError: b is not defined'))).toBeNull();
  });

  it('ignores tools outside the execution set', () => {
    const n = new StrategyNudger();
    const res: ToolResult = { content: 'Error: File not found: /x/y.ts', isError: true };
    n.observe(call('read_file'), res);
    expect(n.observe(call('read_file'), res)).toBeNull();
  });

  it('counts test_run failures', () => {
    const n = new StrategyNudger();
    const res: ToolResult = { content: 'AssertionError: expected 1 to be 2', isError: true };
    n.observe(call('test_run'), res);
    expect(n.observe(call('test_run'), res)).not.toBeNull();
  });

  it('does not count successes in between, but successes advance the window', () => {
    const n = new StrategyNudger();
    n.observe(call(), failure());
    n.observe(call('read_file'), ok);
    expect(n.observe(call(), failure())).not.toBeNull();
  });

  it('treats a recurrence outside the window as a new incident', () => {
    const n = new StrategyNudger();
    n.observe(call(), failure());
    for (let i = 0; i < STRATEGY_NUDGE_WINDOW + 1; i++) n.observe(call('read_file'), ok);
    expect(n.observe(call(), failure())).toBeNull();
    expect(n.occurrencesFor(failure())).toBe(1);
    expect(n.observe(call(), failure())).not.toBeNull();
  });

  it('never fires on generic-only bash failures', () => {
    const n = new StrategyNudger();
    for (let i = 0; i < 5; i++) expect(n.observe(call(), bashFail('some output\nmore output'))).toBeNull();
  });

  // test_run content format; summary/Command/header lines must be skipped
  it('does not nudge when test_run failures differ even with the same pass/fail counts', () => {
    const n = new StrategyNudger();
    // Both have "0 passed | 1 failed" in the summary but different error bullets
    const assertionFail = testRunFail({ passed: 0, failed: 1, errorMsg: 'AssertionError: expected 1 to be 2' });
    const typeFail = testRunFail({ passed: 0, failed: 1, errorMsg: 'TypeError: x is not a function' });
    n.observe(call('test_run', 'pnpm test -t a'), assertionFail);
    expect(n.observe(call('test_run', 'pnpm test -t b'), typeFail)).toBeNull();
  });

  it('nudges when the same test_run failure recurs in the real content format', () => {
    const n = new StrategyNudger();
    const fail = testRunFail({ passed: 0, failed: 1, errorMsg: 'AssertionError: expected "foo" to equal "bar"' });
    n.observe(call('test_run', 'pnpm test -t x'), fail);
    expect(n.observe(call('test_run', 'pnpm test -t y'), fail)).not.toBeNull();
  });

  it('counts a recurrence of the same error bullet in test_run regardless of path differences', () => {
    // The test file path in the bullet normalizes away, so the same test
    // error on different runs produces the same signature.
    const n = new StrategyNudger();
    const failA = testRunFail({
      passed: 0, failed: 1, testName: 'handlesMissing (src/a.test.ts:1)', errorMsg: 'AssertionError: expected 1 to be 2',
    });
    const failB = testRunFail({
      passed: 0, failed: 1, testName: 'handlesMissing (src/b.test.ts:1)', errorMsg: 'AssertionError: expected 1 to be 2',
    });
    n.observe(call('test_run', 'pnpm test -t a'), failA);
    // Same test name + same error message; only file path differs and normalizes away.
    expect(n.observe(call('test_run', 'pnpm test -t b'), failB)).not.toBeNull();
  });

  // head+tail cap: long bullets that differ only in the trailing error message must stay distinct
  it('does not share a signature when two >500-char bullets differ only in the trailing error message', () => {
    const n = new StrategyNudger();
    // Construct a test name that is ~510 chars so the full bullet exceeds 500 chars.
    // The error message is appended AFTER the test name, so a prefix-only cap would
    // cut it off and collapse both bullets into the same signature.
    const longTestName = 'describe ' + 'nested '.repeat(70) + 'it (src/x.test.ts:1)';
    // Sanity: bullet must be >500 chars before the error message is appended.
    const bulletPrefix = `• ${longTestName}: `;
    expect(bulletPrefix.length).toBeGreaterThan(500);

    const failA = testRunFail({ passed: 0, failed: 1, testName: longTestName, errorMsg: 'AssertionError: expected 1 to be 2' });
    const failB = testRunFail({ passed: 0, failed: 1, testName: longTestName, errorMsg: 'TypeError: foo is not a function' });

    n.observe(call('test_run', 'pnpm test -t first'), failA);
    // The two bullets differ ONLY in the trailing error message.
    // With a prefix-only cap both truncate to the same prefix → false nudge.
    // With head+tail they must NOT share a signature.
    expect(n.observe(call('test_run', 'pnpm test -t second'), failB)).toBeNull();
  });

  // eviction must not let an already-fired signature nudge again
  it('never fires again after >256 distinct other signatures evict the original from the map', () => {
    const n = new StrategyNudger();
    const targetFail = () => bashFail('Error: Cannot find module "zod" from /repo/src/x.ts');
    // Fire the nudge for the target signature.
    n.observe(call('bash', 'a'), targetFail());
    expect(n.observe(call('bash', 'b'), targetFail())).not.toBeNull(); // fires once
    // Flood with >256 unique signatures to evict the target from the Map.
    for (let i = 0; i < 260; i++) {
      n.observe(call('bash', `cmd${i}`), bashFail(`Error: unique-error-number-${i} cannot resolve dep unique-${i}`));
    }
    // The target signature's Map entry may have been evicted, but `fired` keeps it.
    expect(n.observe(call('bash', 'c'), targetFail())).toBeNull();
    expect(n.observe(call('bash', 'd'), targetFail())).toBeNull();
  });

  // summary line with a skipped count — bullet must be chosen over the summary
  it('picks the bullet line from a test_run result that includes a skipped count', () => {
    const content =
      '\u274c vitest: 0 passed | 1 failed | 2 skipped \u2014 123ms\n' +
      'Command: pnpm test src/x.test.ts\n' +
      '\nFailed tests:\n' +
      '  \u2022 myTest (src/x.test.ts:5): AssertionError: expected 42 to be 0\n' +
      '\nRAW OUTPUT';
    expect(findErrorLine(content)).toBe(
      '\u2022 myTest (src/x.test.ts:5): AssertionError: expected 42 to be 0',
    );
  });

  // runner crash with no bullet lines — errorSignature must return null
  it('returns null errorSignature for a runner crash with no error-cue bullet', () => {
    // Raw output contains no ERROR_CUE word — simulates a runner segfault / OOM.
    const content =
      '\u274c vitest: 0 passed | 0 failed \u2014 5ms\n' +
      'Command: pnpm test src/x.test.ts\n' +
      '\nKilled\n' +
      'Segmentation fault\n';
    // 'Killed' and 'Segmentation fault' contain no ERROR_CUE match, so null.
    const result: ToolResult = { content, isError: true };
    expect(errorSignature(result)).toBeNull();
  });
});

describe('applyStrategyNudge', () => {
  it('appends the notice, keeps isError, and emits one strategy_nudge_fired event', async () => {
    const n = new StrategyNudger();
    const writer = new InMemoryTraceWriter();
    const first = bashFail('Error: Cannot find module "zod"');
    expect(applyStrategyNudge(n, writer, call('bash', 'a'), first)).toBe(first);
    const out = applyStrategyNudge(n, writer, call('bash', 'b'), bashFail('Error: Cannot find module "zod"'));
    expect(out.isError).toBe(true);
    expect(out.content).toContain('[strategy-nudge]');
    applyStrategyNudge(n, writer, call('bash', 'c'), bashFail('Error: Cannot find module "zod"'));
    await new Promise((r) => setTimeout(r, 0));
    const events = writer.events.filter(
      (e) => e.kind === 'session_phase' && (e.payload as { phase?: string }).phase === 'strategy_nudge_fired',
    );
    expect(events).toHaveLength(1);
    const meta = (events[0]!.payload as { metadata?: Record<string, unknown> }).metadata!;
    expect(meta['tool']).toBe('bash');
    expect(meta['occurrences']).toBe(2);
    expect(meta['distinctCalls']).toBe(true);
    expect(String(meta['errorHead'])).toContain('Cannot find module');
  });

  it('returns successes unchanged', () => {
    const n = new StrategyNudger();
    expect(applyStrategyNudge(n, undefined, call(), ok)).toBe(ok);
  });
});

// Field-observed misfires (witness traces, first day after #3016): the first
// error-cue line was often boilerplate shared by unrelated failures, so two
// different errors collapsed into one signature and fired the nudge.
describe('findErrorLine: boilerplate that must not become the signature', () => {
  const pyTraceback = (frame: string, exception: string) =>
    'Traceback (most recent call last):\n' +
    `  File "/repo/${frame}.py", line 3, in <module>\n` +
    `    run_${frame}()\n` +
    exception;

  it('takes the final exception line of a Python traceback, not its header', () => {
    expect(findErrorLine(pyTraceback('a', "KeyError: 'config'"))).toBe("KeyError: 'config'");
    expect(findErrorLine(pyTraceback('b', 'requests.exceptions.ConnectionError: refused'))).toBe(
      'requests.exceptions.ConnectionError: refused',
    );
  });

  it('takes the exception that escaped from a chained traceback', () => {
    const chained =
      pyTraceback('a', "KeyError: 'config'") +
      '\n\nDuring handling of the above exception, another exception occurred:\n\n' +
      pyTraceback('b', 'RuntimeError: config missing');
    expect(findErrorLine(chained)).toBe('RuntimeError: config missing');
  });

  it('does not fall back to the traceback header when the exception line is cut off', () => {
    expect(findErrorLine('Traceback (most recent call last):\n  File "/repo/a.py", line 3')).toBeNull();
  });

  it('two unrelated Python exceptions do not fire the nudge', () => {
    const n = new StrategyNudger();
    expect(n.observe(call('bash', 'python a.py'), bashFail(pyTraceback('a', "KeyError: 'k'")))).toBeNull();
    const other = bashFail(pyTraceback('b', "ModuleNotFoundError: No module named 'numpy'"));
    expect(n.observe(call('bash', 'python b.py'), other)).toBeNull();
  });

  it('the same Python exception from different frames still fires', () => {
    const n = new StrategyNudger();
    n.observe(call('bash', 'python a.py'), bashFail(pyTraceback('a', "ModuleNotFoundError: No module named 'numpy'")));
    const v = n.observe(
      call('bash', 'python b.py'),
      bashFail(pyTraceback('b', "ModuleNotFoundError: No module named 'numpy'")),
    );
    expect(v?.line).toBe("ModuleNotFoundError: No module named 'numpy'");
  });

  // Verbatim vitest 4 default-reporter output (ANSI stripped), including a test
  // whose NAME contains "error", which the per-test lines would otherwise match.
  const vitestRaw = (assertion: string) =>
    ' ❯ src/zz-probe.test.ts (2 tests | 1 failed) 5ms\n' +
    '   × throws an error on bad input 3ms\n' +
    '   ✓ ok 0ms\n\n' +
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n' +
    ' FAIL  src/zz-probe.test.ts > throws an error on bad input\n' +
    `${assertion}\n\n` +
    ' ❯ src/zz-probe.test.ts:2:54\n' +
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\n' +
    ' Test Files  1 failed (1)\n' +
    '      Tests  1 failed | 1 passed (2)';

  it('skips vitest file summaries, test-name lines, banners, and FAIL headers', () => {
    expect(findErrorLine(vitestRaw('AssertionError: expected 1 to be 2 // Object.is equality'))).toBe(
      'AssertionError: expected 1 to be 2 // Object.is equality',
    );
  });

  it('two different assertion failures in the same test file do not fire the nudge', () => {
    const n = new StrategyNudger();
    n.observe(call('bash', 'pnpm test a'), bashFail(vitestRaw('AssertionError: expected 1 to be 2')));
    expect(
      n.observe(call('bash', 'pnpm test b'), bashFail(vitestRaw("TypeError: Cannot read properties of undefined (reading 'x')"))),
    ).toBeNull();
  });

  it('keeps a FAIL line that is not a test-file header', () => {
    expect(findErrorLine('FAIL a/Makefile not created: wasNew capture failed')).toBe(
      'FAIL a/Makefile not created: wasNew capture failed',
    );
  });

  it('skips node source echo above a caret and unhandled-rejection internals', () => {
    const rejection =
      'node:internal/process/promises:391\n' +
      '    triggerUncaughtException(err, true /* fromPromise */);\n' +
      '    ^\n\n' +
      "Error: ENOENT: no such file or directory, open '/x/a.json'";
    expect(findErrorLine(rejection)).toBe("Error: ENOENT: no such file or directory, open '/x/a.json'");
    const thrown =
      '/private/tmp/t.js:2\nthrow new TypeError("bad input " + x);\n^\n\nTypeError: bad input 1\n    at Object.<anonymous> (/private/tmp/t.js:2:7)';
    expect(findErrorLine(thrown)).toBe('TypeError: bad input 1');
  });

  it('skips success lines that merely mention errors', () => {
    expect(findErrorLine('PASS desktop: no console errors/warnings\nFAIL mobile: layout overflow at 375px')).toBeNull();
    expect(findErrorLine('✓ no errors on load\nError: layout overflow at 375px')).toBe(
      'Error: layout overflow at 375px',
    );
  });

  // Issue #3216 finding 1: traceback-context check
  it('ignores an exception-shaped line in mixed output that follows the real traceback', () => {
    // A real traceback followed by unrelated output that happens to contain an
    // exception-shaped identifier (e.g. a log line or test-output label).
    // lastPythonException must return the real exception, not the bogus one below.
    const mixed =
      'Traceback (most recent call last):\n' +
      '  File "/repo/app.py", line 5, in main\n' +
      '    do_work()\n' +
      'ValueError: bad value\n' +
      '\nsome log output\n' +
      'RuntimeError: this line looks like an exception but has no traceback context\n';
    expect(findErrorLine(mixed)).toBe('ValueError: bad value');
  });

  // Issue #3216 finding 2: additional failure-glyph coverage
  it('skips per-test status lines with ✘ (U+2718) and ✖ (U+2716) glyphs', () => {
    // ✘ and ✖ were previously missing from the GENERIC_LINES filter.
    expect(findErrorLine('✘ throws on bad input 3ms\nAssertionError: expected 1 to be 2')).toBe(
      'AssertionError: expected 1 to be 2',
    );
    expect(findErrorLine('✖ fails with error 5ms\nTypeError: x is not defined')).toBe(
      'TypeError: x is not defined',
    );
  });

  // Issue #3216 finding 3: MAX_LINES_SCANNED truncation
  it('returns null when MAX_LINES_SCANNED (400) truncates a Python traceback before its exception line', () => {
    // Build output where the Traceback header is in the first 400 lines, but the
    // exception line sits beyond line 400 so split() never reaches it.
    // findErrorLine uses split('\n', MAX_LINES_SCANNED) which keeps at most 400
    // elements (indices 0-399), so the exception line at index 400 is safely
    // degraded to null.
    //
    // Explicit assertion: the Traceback header MUST be inside the 400-element
    // window so the test exercises the "header visible, exception cut off"
    // scenario; if filler-length changes push the header past index 399, the test
    // would pass for the wrong reason (nothing was ever found).
    //
    // Layout (0-based indices into the split array):
    //   0..397  filler (398 lines)
    //   398     Traceback header        ← inside the 400-element window
    //   399     frame line              ← last element returned by split(…, 400)
    //   400     RuntimeError            ← beyond the limit, never seen
    const filler = Array.from({ length: 398 }, (_, i) => `output line ${i}`).join('\n');
    const content =
      filler + '\n' +
      'Traceback (most recent call last):\n' + // index 398 — inside the window
      '  File "/repo/app.py", line 1, in main\n' + // index 399 — last visible
      'RuntimeError: never reached\n'; // index 400 — beyond the scan window
    // Sanity: the Traceback header is within the first 400 elements.
    const scanned = content.split('\n', 400);
    expect(scanned.some((l) => /^traceback \(most recent call last\)/i.test(l.trim()))).toBe(true);
    // The exception line itself must be absent from the scanned window.
    expect(scanned.some((l) => /^RuntimeError/.test(l.trim()))).toBe(false);
    expect(findErrorLine(content)).toBeNull();
  });

  // Issue #3281: collapsed-frame marker preceding RecursionError must be accepted
  it('extracts RecursionError from a real recursive traceback (collapsed-frame marker)', () => {
    // Python condenses deep stacks to:
    //   File "x.py", line N, in f
    //     return f()
    //   [Previous line repeated 996 more times]
    // RecursionError: maximum recursion depth exceeded
    // The marker has 2-space indent; without the new PY_TRACEBACK_PREDECESSOR
    // branch it did not match and lastPythonException returned null.
    const content =
      'Traceback (most recent call last):\n' +
      '  File "x.py", line 2, in f\n' +
      '    return f()\n' +
      '  [Previous line repeated 996 more times]\n' +
      'RecursionError: maximum recursion depth exceeded';
    expect(findErrorLine(content)).toBe('RecursionError: maximum recursion depth exceeded');
  });

  it('fires the nudge for a recurring RecursionError from a recursive traceback', () => {
    const recursionTraceback = (filename: string) =>
      'Traceback (most recent call last):\n' +
      `  File "${filename}", line 2, in f\n` +
      '    return f()\n' +
      '  [Previous line repeated 996 more times]\n' +
      'RecursionError: maximum recursion depth exceeded';
    const n = new StrategyNudger();
    expect(n.observe(call('bash', 'python a.py'), bashFail(recursionTraceback('a.py')))).toBeNull();
    const v = n.observe(call('bash', 'python b.py'), bashFail(recursionTraceback('b.py')));
    expect(v).not.toBeNull();
    expect(v!.line).toBe('RecursionError: maximum recursion depth exceeded');
  });

  it('handles singular "time" variant of the collapsed-frame marker', () => {
    // Python can print "repeated 1 more time" (singular) — the regex must match both.
    const content =
      'Traceback (most recent call last):\n' +
      '  File "x.py", line 2, in f\n' +
      '    return f()\n' +
      '  [Previous line repeated 1 more time]\n' +
      'RecursionError: maximum recursion depth exceeded';
    expect(findErrorLine(content)).toBe('RecursionError: maximum recursion depth exceeded');
  });

  // Issue #3303: tightened predecessor regex — zero-indent marker must not match
  it('does not treat a zero-indent collapsed-frame marker as a traceback predecessor', () => {
    // CPython always emits "[Previous line repeated N more times]" with 2-space
    // indent. A zero-indent variant is not real traceback output; after the regex
    // tightening it must not satisfy the predecessor guard.
    //
    // Scenario: real traceback ends with ValueError; below it is mixed log output
    // that happens to contain a zero-indent marker and then an exception-shaped
    // identifier. lastPythonException must return ValueError (from the real
    // traceback), not the bogus identifier that follows the zero-indent marker.
    const content =
      'Traceback (most recent call last):\n' +
      '  File "x.py", line 5, in main\n' +
      '    do_work()\n' +
      'ValueError: something went wrong\n' +
      '\nsome log output\n' +
      '[Previous line repeated 996 more times]\n' + // zero-indent — not valid CPython predecessor
      'RecursionError: this is not a real traceback exception but looks like one';
    // The real exception is ValueError; the bogus RecursionError-shaped line after
    // the zero-indent marker must not be selected over it.
    expect(findErrorLine(content)).toBe('ValueError: something went wrong');
  });

  // Issue #3303: chained exception combined with collapsed-frame marker
  it('extracts RecursionError from a chained traceback where the second chain has a collapsed-frame marker', () => {
    // "During handling of the above exception" connects two tracebacks; the second
    // one ends with a collapsed-frame marker directly before RecursionError.
    // lastPythonException must scan backward, accept the collapsed-frame marker as
    // a valid predecessor, and return the escaped exception (RecursionError).
    const content =
      'Traceback (most recent call last):\n' +
      '  File "handler.py", line 5, in handle\n' +
      '    do_work()\n' +
      'KeyError: missing key\n' +
      '\nDuring handling of the above exception, another exception occurred:\n\n' +
      'Traceback (most recent call last):\n' +
      '  File "recurse.py", line 2, in f\n' +
      '    return f()\n' +
      '  [Previous line repeated 996 more times]\n' +
      'RecursionError: maximum recursion depth exceeded';
    expect(findErrorLine(content)).toBe('RecursionError: maximum recursion depth exceeded');
  });
});
