/**
 * Unit tests for the shadow-git-detect observe-window aggregator (#3849).
 *
 * Strategy: synthetic temp-dir fixtures with controlled trace JSONL + session
 * sidecars. No real AFK_HOME reads. Mirrors the approach in
 * guardrail-false-positives.test.ts.
 *
 * @module insights/aggregators/shadow-git-observe.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateShadowGitObserve,
  zeroShadowGitObserveAggregates,
  SHADOW_GIT_OBSERVE_REASON_PREFIX,
} from './shadow-git-observe.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-sgo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'state', 'witness'), { recursive: true });
  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW_ISO = new Date().toISOString();

function writeTrace(sessionId: string, lines: string[]): void {
  const dir = join(tmpRoot, 'state', 'witness', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

function writeSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(tmpRoot, 'state', 'sessions', `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      model: 'claude-3-5-sonnet',
      startedAt: Date.now() - 1000,
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [],
      ...overrides,
    }),
    'utf-8',
  );
}

function opts(days = 30) {
  return { days, afkHome: tmpRoot };
}

// ---------------------------------------------------------------------------
// JSONL line builders
// ---------------------------------------------------------------------------

function shadowGitEvent(
  seq: number,
  labels: string[],
  subagentId?: string,
): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'hook_decision',
    payload: {
      hookEvent: 'PreToolUse',
      decision: 'approve',
      reason: `${SHADOW_GIT_OBSERVE_REASON_PREFIX} [${labels.join(', ')}]`,
      blockedTool: 'bash',
      ...(subagentId ? { subagentId } : {}),
    },
  });
}

function unrelatedHookDecision(seq: number): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'hook_decision',
    payload: {
      hookEvent: 'PreToolUse',
      decision: 'block',
      reason: 'some-other-guard reason',
      blockedTool: 'bash',
    },
  });
}

// ---------------------------------------------------------------------------
// Tests: zero-aggregate factory
// ---------------------------------------------------------------------------

describe('zeroShadowGitObserveAggregates', () => {
  it('returns expected zero shape', () => {
    const z = zeroShadowGitObserveAggregates();
    expect(z.totalFirings).toBe(0);
    expect(z.forkFirings).toBe(0);
    expect(z.sessionsWithFirings).toBe(0);
    expect(z.sessionsScanned).toBe(0);
    expect(z.byLabel).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: SHADOW_GIT_OBSERVE_REASON_PREFIX constant
// ---------------------------------------------------------------------------

describe('SHADOW_GIT_OBSERVE_REASON_PREFIX', () => {
  it('matches the shadow-git-detect producer prefix', () => {
    expect(SHADOW_GIT_OBSERVE_REASON_PREFIX).toBe('shadow-git observe-only');
  });
});

// ---------------------------------------------------------------------------
// Tests: no sessions / no firings
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — no sessions', () => {
  it('returns zero-aggregate when sessions dir is empty', () => {
    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(0);
    expect(result.sessionsScanned).toBe(0);
  });

  it('returns zero-aggregate when session has no trace file', () => {
    writeSession('sess-no-trace');
    const result = aggregateShadowGitObserve(opts());
    expect(result.sessionsScanned).toBe(0);
  });

  it('returns zero-aggregate when trace has only unrelated hook_decision events', () => {
    writeSession('sess-unrelated');
    writeTrace('sess-unrelated', [unrelatedHookDecision(1)]);
    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(0);
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsWithFirings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: basic firing detection
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — firing detection', () => {
  it('counts a single shadow-git event', () => {
    writeSession('sess-one');
    writeTrace('sess-one', [shadowGitEvent(1, ['no-verify'])]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
    expect(result.sessionsWithFirings).toBe(1);
    expect(result.sessionsScanned).toBe(1);
    expect(result.forkFirings).toBe(0);
  });

  it('counts multiple firings in one session', () => {
    writeSession('sess-multi');
    writeTrace('sess-multi', [
      shadowGitEvent(1, ['no-verify']),
      shadowGitEvent(2, ['author-override']),
      shadowGitEvent(3, ['no-verify']),
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(3);
    expect(result.sessionsWithFirings).toBe(1);
  });

  it('sums firings across multiple sessions', () => {
    writeSession('sess-a');
    writeTrace('sess-a', [shadowGitEvent(1, ['no-verify'])]);
    writeSession('sess-b');
    writeTrace('sess-b', [shadowGitEvent(1, ['env-identity']), shadowGitEvent(2, ['env-identity'])]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(3);
    expect(result.sessionsWithFirings).toBe(2);
    expect(result.sessionsScanned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: fork attribution
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — fork attribution', () => {
  it('counts fork firing when subagentId is present', () => {
    writeSession('sess-fork');
    writeTrace('sess-fork', [shadowGitEvent(1, ['no-verify'], 'child-abc')]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
    expect(result.forkFirings).toBe(1);
  });

  it('does not count root firing as fork', () => {
    writeSession('sess-root');
    writeTrace('sess-root', [shadowGitEvent(1, ['no-verify'])]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
    expect(result.forkFirings).toBe(0);
  });

  it('counts mixed root and fork firings correctly', () => {
    writeSession('sess-mixed');
    writeTrace('sess-mixed', [
      shadowGitEvent(1, ['no-verify']),               // root
      shadowGitEvent(2, ['author-override'], 'c-1'),  // fork
      shadowGitEvent(3, ['env-identity'], 'c-2'),     // fork
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(3);
    expect(result.forkFirings).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: label breakdown
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — byLabel', () => {
  it('extracts single label', () => {
    writeSession('sess-label-single');
    writeTrace('sess-label-single', [shadowGitEvent(1, ['no-verify'])]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.byLabel['no-verify']).toBe(1);
  });

  it('extracts multiple labels from one event', () => {
    writeSession('sess-label-multi');
    writeTrace('sess-label-multi', [shadowGitEvent(1, ['no-verify', 'author-override'])]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.byLabel['no-verify']).toBe(1);
    expect(result.byLabel['author-override']).toBe(1);
  });

  it('accumulates same label across events', () => {
    writeSession('sess-label-acc');
    writeTrace('sess-label-acc', [
      shadowGitEvent(1, ['no-verify']),
      shadowGitEvent(2, ['no-verify']),
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.byLabel['no-verify']).toBe(2);
  });

  it('bins malformed reason suffix under "unknown"', () => {
    writeSession('sess-label-bad');
    writeTrace('sess-label-bad', [
      JSON.stringify({
        ts: NOW_ISO,
        seq: 1,
        kind: 'hook_decision',
        payload: {
          hookEvent: 'PreToolUse',
          decision: 'approve',
          reason: `${SHADOW_GIT_OBSERVE_REASON_PREFIX} malformed-no-brackets`,
        },
      }),
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
    expect(result.byLabel['unknown']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: time window filtering
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — time window', () => {
  it('excludes sessions older than the window', () => {
    const OLD_TS = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeSession('sess-old', { startedAt: new Date(OLD_TS).getTime() });
    writeTrace('sess-old', [shadowGitEvent(1, ['no-verify'])]);

    const result = aggregateShadowGitObserve({ days: 30, afkHome: tmpRoot });
    expect(result.sessionsScanned).toBe(0);
    expect(result.totalFirings).toBe(0);
  });

  it('includes sessions within the window', () => {
    writeSession('sess-recent');
    writeTrace('sess-recent', [shadowGitEvent(1, ['no-verify'])]);

    const result = aggregateShadowGitObserve({ days: 30, afkHome: tmpRoot });
    expect(result.sessionsScanned).toBe(1);
    expect(result.totalFirings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: decision filter
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — decision filter', () => {
  it('does not count a block decision even when reason prefix matches', () => {
    writeSession('sess-block-decision');
    writeTrace('sess-block-decision', [
      // Same reason prefix as shadow-git observe events, but decision: 'block'.
      // This should NOT be counted — only 'approve' decisions are shadow-git
      // observe firings; 'block' comes from a different guard.
      JSON.stringify({
        ts: NOW_ISO,
        seq: 1,
        kind: 'hook_decision',
        payload: {
          hookEvent: 'PreToolUse',
          decision: 'block',
          reason: `${SHADOW_GIT_OBSERVE_REASON_PREFIX} [no-verify]`,
          blockedTool: 'bash',
        },
      }),
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(0);
    expect(result.sessionsWithFirings).toBe(0);
    expect(result.sessionsScanned).toBe(1);
  });

  it('counts approve but not block when both appear in the same session', () => {
    writeSession('sess-mixed-decision');
    writeTrace('sess-mixed-decision', [
      shadowGitEvent(1, ['no-verify']),   // approve — should count
      JSON.stringify({
        ts: NOW_ISO,
        seq: 2,
        kind: 'hook_decision',
        payload: {
          hookEvent: 'PreToolUse',
          decision: 'block',
          reason: `${SHADOW_GIT_OBSERVE_REASON_PREFIX} [no-verify]`,
          blockedTool: 'bash',
        },
      }),                                 // block — must not count
    ]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
    expect(result.sessionsWithFirings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: resilience
// ---------------------------------------------------------------------------

describe('aggregateShadowGitObserve — resilience', () => {
  it('skips malformed JSONL lines without throwing', () => {
    writeSession('sess-bad-json');
    writeTrace('sess-bad-json', [
      'not-json-at-all',
      shadowGitEvent(1, ['no-verify']),
    ]);

    expect(() => aggregateShadowGitObserve(opts())).not.toThrow();
    const result = aggregateShadowGitObserve(opts());
    expect(result.totalFirings).toBe(1);
  });

  it('handles a trace with no shadow-git events (sessionsScanned increments, no firings)', () => {
    writeSession('sess-no-sg');
    writeTrace('sess-no-sg', [unrelatedHookDecision(1)]);

    const result = aggregateShadowGitObserve(opts());
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsWithFirings).toBe(0);
    expect(result.totalFirings).toBe(0);
  });
});
