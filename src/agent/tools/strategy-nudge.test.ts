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
