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

  // Item 1: test_run content format; summary/Command/header lines must be skipped
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
