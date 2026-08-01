import { describe, expect, it, beforeEach } from 'vitest';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import {
  RepeatFailureGuard,
  REPEAT_FAILURE_REFUSAL_THRESHOLD,
  repeatFailureFingerprint,
} from './repeat-failure-guard.js';

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${Math.random().toString(16).slice(2)}`, name, input } as ToolCall;
}

function failure(content = 'browserType.launch: Executable does not exist'): ToolResult {
  return { content, isError: true };
}

function success(content = 'ok'): ToolResult {
  return { content, isError: false };
}

let guard: RepeatFailureGuard;

beforeEach(() => {
  guard = new RepeatFailureGuard();
});

/** Drive N consecutive failures of the same call shape through the guard. */
function failTimes(name: string, input: Record<string, unknown>, times: number): void {
  for (let i = 0; i < times; i++) guard.note(call(name, input), failure());
}

describe('RepeatFailureGuard — refusal after a failure streak', () => {
  it('permits the call until the threshold is reached', () => {
    const input = { url: 'https://example.com' };
    for (let i = 0; i < REPEAT_FAILURE_REFUSAL_THRESHOLD - 1; i++) {
      guard.note(call('browser_open', input), failure());
      expect(guard.check(call('browser_open', input))).toBeNull();
    }
  });

  it('refuses once the streak reaches the threshold, without executing', () => {
    const input = { url: 'https://example.com' };
    failTimes('browser_open', input, REPEAT_FAILURE_REFUSAL_THRESHOLD);

    const verdict = guard.check(call('browser_open', input));
    expect(verdict).not.toBeNull();
    expect(verdict?.count).toBe(REPEAT_FAILURE_REFUSAL_THRESHOLD);
    expect(verdict?.result.isError).toBe(true);
    expect(verdict?.result.failureClass).toBe('repeat-failure');
  });

  it('names the repetition count and quotes the prior failure', () => {
    const input = { url: 'https://example.com' };
    for (let i = 0; i < REPEAT_FAILURE_REFUSAL_THRESHOLD; i++) {
      guard.note(call('browser_open', input), failure('Executable does not exist: chrome-headless'));
    }
    const content = guard.check(call('browser_open', input))?.result.content ?? '';
    expect(content).toContain('browser_open');
    expect(content).toContain(String(REPEAT_FAILURE_REFUSAL_THRESHOLD));
    expect(content).toContain('Executable does not exist: chrome-headless');
  });
});

describe('RepeatFailureGuard — argument jitter cannot defeat it', () => {
  it('trips despite a changed timeout_ms', () => {
    // The advisory breaker keys on byte-identical input, so bumping a deadline
    // resets it. A deadline governs how long the same operation may run, never
    // what it does, so it must not reset this guard.
    guard.note(call('browser_open', { url: 'https://x.test', timeout_ms: 10_000 }), failure());
    guard.note(call('browser_open', { url: 'https://x.test', timeout_ms: 20_000 }), failure());
    guard.note(call('browser_open', { url: 'https://x.test', timeout_ms: 45_000 }), failure());

    const verdict = guard.check(call('browser_open', { url: 'https://x.test', timeout_ms: 99_000 }));
    expect(verdict?.count).toBe(3);
  });

  it('trips despite re-ordered keys', () => {
    guard.note(call('bash', { command: 'ls', description: 'list' }), failure());
    guard.note(call('bash', { description: 'list', command: 'ls' }), failure());
    guard.note(call('bash', { command: 'ls', description: 'list' }), failure());

    expect(guard.check(call('bash', { description: 'list', command: 'ls' }))).not.toBeNull();
  });

  it('fingerprints jittered and re-ordered variants identically', () => {
    const a = repeatFailureFingerprint(call('browser_open', { url: 'u', timeout_ms: 1 }));
    const b = repeatFailureFingerprint(call('browser_open', { timeout_ms: 2, url: 'u' }));
    expect(a).toBe(b);
  });
});

describe('RepeatFailureGuard — what it must never refuse', () => {
  it('never refuses a repeatedly SUCCEEDING call', () => {
    const input = { file_path: '/tmp/a.txt' };
    for (let i = 0; i < REPEAT_FAILURE_REFUSAL_THRESHOLD + 3; i++) {
      guard.note(call('read_file', input), success());
    }
    expect(guard.check(call('read_file', input))).toBeNull();
  });

  it('clears the streak on a success, so intermittent tools are never refused', () => {
    const input = { url: 'https://flaky.test' };
    failTimes('browser_open', input, REPEAT_FAILURE_REFUSAL_THRESHOLD - 1);
    guard.note(call('browser_open', input), success());
    expect(guard.streakFor(call('browser_open', input))).toBe(0);

    guard.note(call('browser_open', input), failure());
    expect(guard.check(call('browser_open', input))).toBeNull();
  });

  it('does not leak a streak across a different tool', () => {
    failTimes('browser_open', { url: 'u' }, REPEAT_FAILURE_REFUSAL_THRESHOLD);
    expect(guard.check(call('web_scrape', { url: 'u' }))).toBeNull();
  });

  it('does not leak a streak across materially different arguments', () => {
    failTimes('browser_open', { url: 'https://a.test' }, REPEAT_FAILURE_REFUSAL_THRESHOLD);
    expect(guard.check(call('browser_open', { url: 'https://b.test' }))).toBeNull();
  });

  it('treats a semantic argument as significant even though timeouts are stripped', () => {
    const fpA = repeatFailureFingerprint(call('bash', { command: 'ls', timeout_ms: 1 }));
    const fpB = repeatFailureFingerprint(call('bash', { command: 'rm -rf x', timeout_ms: 1 }));
    expect(fpA).not.toBe(fpB);
  });
});

describe('RepeatFailureGuard — robustness', () => {
  it('survives a non-object input without throwing', () => {
    const odd = { id: 'x', name: 'weird', input: 'a-string' } as unknown as ToolCall;
    expect(() => guard.note(odd, failure())).not.toThrow();
    expect(() => guard.check(odd)).not.toThrow();
  });

  it('truncates a very long prior error in the refusal message', () => {
    const input = { url: 'u' };
    const huge = 'E'.repeat(5_000);
    for (let i = 0; i < REPEAT_FAILURE_REFUSAL_THRESHOLD; i++) {
      guard.note(call('browser_open', input), failure(huge));
    }
    const content = guard.check(call('browser_open', input))?.result.content ?? '';
    expect(content.length).toBeLessThan(1_200);
    expect(content).toContain('…');
  });
});
