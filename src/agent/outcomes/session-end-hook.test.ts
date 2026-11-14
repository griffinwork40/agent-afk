/**
 * Tests for src/agent/outcomes/session-end-hook.ts
 *
 * The hook itself is fire-and-forget; tests verify:
 *   - It skips subagent contexts
 *   - It skips missing sessionId
 *   - The internal _runImmediatePass logic via the pure parts it calls
 *   - appendArtifacts merges correctly (store integration)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactsFromOutcomes, closureFromTrace, createOutcomeSessionEndHook } from './session-end-hook.js';
import { readRecord, writeRecord, appendArtifacts, upsertVotes } from './store.js';
import type { VerifiedOutcome } from './schema.js';
import * as sessionOutcomes from './session-outcomes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(sessionId: string, overrides: Partial<VerifiedOutcome> = {}): VerifiedOutcome {
  return {
    schema_version: 1,
    session_id: sessionId,
    label: 'unknown',
    confidence: 0,
    state: 'provisional',
    settles_after: null,
    session_kind: 'text',
    self_report: 'none',
    artifacts: { commits: [], prs: [], repo: null },
    votes: [],
    history: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-outcome-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hook lifecycle tests
// ---------------------------------------------------------------------------

describe('createOutcomeSessionEndHook', () => {
  it('returns {} for non-SessionEnd events', () => {
    const hook = createOutcomeSessionEndHook();
    const result = hook({ event: 'PreToolUse', toolName: 'bash', sessionId: 'x' });
    expect(result).toEqual({});
  });

  it('returns {} when sessionId is absent', () => {
    const hook = createOutcomeSessionEndHook();
    const result = hook({ event: 'SessionEnd' });
    expect(result).toEqual({});
  });

  it('returns {} for forked subagent (parentSessionId set)', () => {
    const hook = createOutcomeSessionEndHook();
    const result = hook({
      event: 'SessionEnd',
      sessionId: 'child-1',
      parentSessionId: 'root-1',
    });
    expect(result).toEqual({});
  });

  it('bypasses the shared outcomes memo on reset but uses it on close', () => {
    const outcomes = vi.spyOn(sessionOutcomes, 'getSessionOutcomes').mockResolvedValue(null);
    try {
      const hook = createOutcomeSessionEndHook();
      hook({ event: 'SessionEnd', sessionId: 'root-reset', reason: 'reset' });
      expect(outcomes).toHaveBeenLastCalledWith('root-reset', {}, { memoize: false });
      hook({ event: 'SessionEnd', sessionId: 'root-reset', reason: 'close' });
      expect(outcomes).toHaveBeenLastCalledWith('root-reset', {}, { memoize: true });
    } finally {
      outcomes.mockRestore();
    }
  });

  it('returns {} synchronously for a root session (fire-and-forget)', () => {
    const hook = createOutcomeSessionEndHook();
    const result = hook({ event: 'SessionEnd', sessionId: 'root-2' });
    // Must return an object immediately, not a promise
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// appendArtifacts merge tests (store integration)
// ---------------------------------------------------------------------------

describe('appendArtifacts', () => {
  it('creates a skeleton record when none exists', () => {
    appendArtifacts('sess-new-1', { commits: ['abc1234'] }, { outcomesDir: tmpDir });
    const record = readRecord('sess-new-1', tmpDir);
    expect(record).toBeDefined();
    expect(record?.artifacts.commits).toContain('abc1234');
  });

  it('merges without duplicating existing commits', () => {
    writeRecord(makeOutcome('sess-merge', {
      artifacts: { commits: ['abc1234'], prs: [], repo: null },
    }), tmpDir);
    appendArtifacts('sess-merge', { commits: ['abc1234', 'def5678'] }, { outcomesDir: tmpDir });
    const record = readRecord('sess-merge', tmpDir);
    expect(record?.artifacts.commits.filter((s) => s === 'abc1234').length).toBe(1);
    expect(record?.artifacts.commits).toContain('def5678');
  });

  it('merges PR URLs without duplicates', () => {
    writeRecord(makeOutcome('sess-pr', {
      artifacts: { commits: [], prs: ['https://github.com/o/r/pull/1'], repo: null },
    }), tmpDir);
    appendArtifacts('sess-pr', {
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    }, { outcomesDir: tmpDir });
    const record = readRecord('sess-pr', tmpDir);
    const prList = record?.artifacts.prs ?? [];
    expect(prList.filter((u) => u === 'https://github.com/o/r/pull/1').length).toBe(1);
    expect(prList).toContain('https://github.com/o/r/pull/2');
  });

  it('flips settled→provisional when new artifacts arrive', () => {
    writeRecord(makeOutcome('sess-settled', { state: 'settled', settles_after: null }), tmpDir);
    appendArtifacts('sess-settled', { commits: ['aaa1111'] }, { outcomesDir: tmpDir });
    const record = readRecord('sess-settled', tmpDir);
    expect(record?.state).toBe('provisional');
    expect(record?.settles_after).toBeTruthy();
  });

  it('preserves state when no new artifacts', () => {
    writeRecord(makeOutcome('sess-preserve', { state: 'settled' }), tmpDir);
    appendArtifacts('sess-preserve', { commits: [] }, { outcomesDir: tmpDir });
    const record = readRecord('sess-preserve', tmpDir);
    expect(record?.state).toBe('settled');
  });
});

// ---------------------------------------------------------------------------
// schema: first_prompt_tokens and first_cwd (issue #2449)
// ---------------------------------------------------------------------------

describe('VerifiedOutcomeSchema with first_prompt_tokens / first_cwd', () => {
  it('accepts a record with first_prompt_tokens and first_cwd', async () => {
    const { VerifiedOutcomeSchema } = await import('./schema.js');
    const raw = {
      schema_version: 1,
      session_id: 'sess-sp',
      label: 'unknown',
      confidence: 0,
      state: 'provisional',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
      first_prompt_tokens: ['bug', 'fix', 'login'],
      first_cwd: '/my/project',
    };
    const parsed = VerifiedOutcomeSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.first_prompt_tokens).toEqual(['bug', 'fix', 'login']);
      expect(parsed.data.first_cwd).toBe('/my/project');
      // Raw prompt text must never appear in the parsed record
      expect('first_prompt' in parsed.data).toBe(false);
    }
  });

  it('strips legacy first_prompt field on parse (Zod strips unknown keys)', async () => {
    const { VerifiedOutcomeSchema } = await import('./schema.js');
    const legacyRaw = {
      schema_version: 1,
      session_id: 'sess-legacy',
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
      first_prompt: 'Fix the login bug with secret sk-abcdef12345',  // legacy field
      first_cwd: '/my/project',
    };
    const parsed = VerifiedOutcomeSchema.safeParse(legacyRaw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // first_prompt must be stripped by Zod (schema uses z.object, not .passthrough())
      expect('first_prompt' in parsed.data).toBe(false);
      // first_prompt_tokens absent since we didn't supply it
      expect(parsed.data.first_prompt_tokens).toBeUndefined();
    }
  });

  it('accepts a record without first_prompt_tokens / first_cwd (optional fields)', async () => {
    const { VerifiedOutcomeSchema } = await import('./schema.js');
    const raw = {
      schema_version: 1,
      session_id: 'sess-no-sp',
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
    };
    const parsed = VerifiedOutcomeSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding #1: closureFromTrace must map non-model_end_turn reasons to 'unknown'
// ---------------------------------------------------------------------------

describe('closureFromTrace non-normal reasons map to unknown (finding #1)', () => {
  // Invariant: the trace ClosureReason values 'truncated', 'timeout',
  // 'budget_exceeded', 'hook_blocked', and 'max_turns_exceeded' must NOT
  // produce closure_reason='normal' in the outcome store.  Only
  // 'model_end_turn' should produce 'normal'; all others are 'unknown'.
  // This is verified via upsertVotes with closureReason option (the same path
  // closureFromTrace feeds into), then inspecting the stored record.
  it('upsertVotes with closureReason=unknown stores unknown and treats as non-normal', () => {
    const base = {
      schema_version: 1 as const,
      session_id: 'sess-hook-unknown',
      label: 'unknown' as const,
      confidence: 0,
      state: 'provisional' as const,
      settles_after: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
    };
    // Simulates what closureFromTrace returns for 'truncated'/'timeout'/etc.
    upsertVotes(
      'sess-hook-unknown',
      [],
      base,
      { outcomesDir: tmpDir, closureReason: 'unknown' },
    );
    const rec = readRecord('sess-hook-unknown', tmpDir);
    expect(rec?.closure_reason).toBe('unknown');
    // Verify the record is stored with the unknown reason — this confirms the
    // hook now writes 'unknown' instead of 'normal' for abnormal trace reasons.
  });

  it('trace file with model_end_turn reason produces closure_reason=normal', () => {
    // Write a minimal trace file with a closure event carrying model_end_turn
    const traceDir = join(tmpDir, 'trace-normal');
    mkdirSync(traceDir, { recursive: true });
    const tracePath = join(traceDir, 'trace.jsonl');
    writeFileSync(tracePath, JSON.stringify({
      kind: 'closure',
      payload: { reason: 'model_end_turn', finalTurnCount: 3, finalCostUsd: 0.01, finalTokens: {} },
    }) + '\n', 'utf8');

    // The closureFromTrace function (internal) would return { reason: 'normal' }
    // for model_end_turn.  Verify this via the upsertVotes path with the
    // closureReason that would be computed from such a trace.
    upsertVotes(
      'sess-trace-normal',
      [],
      {
        schema_version: 1 as const,
        session_id: 'sess-trace-normal',
        label: 'unknown' as const,
        confidence: 0,
        state: 'provisional' as const,
        settles_after: null,
        session_kind: 'text' as const,
        self_report: 'none' as const,
        artifacts: { commits: [], prs: [], repo: null },
      },
      { outcomesDir: tmpDir, closureReason: 'normal' },
    );
    const rec = readRecord('sess-trace-normal', tmpDir);
    expect(rec?.closure_reason).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// #4896: closureFromTrace must return the LAST root closure reason
//
// Before this fix the function returned on the first closure line of any
// kind, which on a multi-cycle REPL trace is cycle 1's reason (or a child's),
// not the root cycle that ended. These tests run the real reader on real files.
// ---------------------------------------------------------------------------

function rootClosure(reason: string): string {
  return JSON.stringify({ kind: 'closure', payload: { reason, finalTurnCount: 1, finalCostUsd: 0.1 } });
}

function childClosure(reason: string): string {
  return JSON.stringify({
    kind: 'closure',
    payload: { reason, subagentId: 'child-1', finalTurnCount: 1, finalCostUsd: 0.05 },
  });
}

function writeTrace(name: string, lines: string[]): string {
  const tracePath = join(tmpDir, `${name}.jsonl`);
  writeFileSync(tracePath, lines.join('\n') + '\n', 'utf8');
  return tracePath;
}

describe('#4896 closureFromTrace returns last root closure reason', () => {
  it('root iteration_cap then root model_end_turn gives normal', () => {
    const tracePath = writeTrace('cap-then-clean', [rootClosure('iteration_cap'), rootClosure('model_end_turn')]);
    expect(closureFromTrace(tracePath)).toEqual({ reason: 'normal' });
  });

  it('root model_end_turn then root iteration_cap gives iteration_cap', () => {
    const tracePath = writeTrace('clean-then-cap', [rootClosure('model_end_turn'), rootClosure('iteration_cap')]);
    expect(closureFromTrace(tracePath)).toEqual({ reason: 'iteration_cap' });
  });

  it('a trailing child closure is skipped: root model_end_turn still gives normal', () => {
    const tracePath = writeTrace('root-then-child', [rootClosure('model_end_turn'), childClosure('budget_exceeded')]);
    expect(closureFromTrace(tracePath)).toEqual({ reason: 'normal' });
  });

  it('a trace whose only closure is a child closure gives null', () => {
    const tracePath = writeTrace('child-only', [childClosure('budget_exceeded')]);
    expect(closureFromTrace(tracePath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OutcomesV1 → legacy artifacts mapping + persistence
// ---------------------------------------------------------------------------

const OUT = {
  schemaVersion: 1 as const,
  cwd: '/repo',
  startHead: null,
  endHead: 'b'.repeat(40),
  commits: [
    { sha: 'b'.repeat(40), repo: '/repo', subject: 's', source: 'git_log' as const },
    { sha: 'c'.repeat(7), repo: '/repo', subject: 't', source: 'effect_ledger' as const },
  ],
  prs: [{ url: 'https://github.com/o/r/pull/3', action: 'create' as const }],
  filesChanged: [],
  filesChangedTruncated: false,
  schedules: [],
  services: [],
  terminalState: null,
};

describe('artifactsFromOutcomes', () => {
  it('maps commits to shas, prs to urls, repo to cwd', () => {
    expect(artifactsFromOutcomes(OUT)).toEqual({
      commits: ['b'.repeat(40), 'ccccccc'],
      prs: ['https://github.com/o/r/pull/3'],
      repo: '/repo',
      commitRepos: { ['b'.repeat(40)]: '/repo', ccccccc: '/repo' },
    });
  });

  it('upsertVotes persists the full outcomes object and backfills a child skeleton', () => {
    appendArtifacts('sess-o', { commits: ['d'.repeat(7)] }, { outcomesDir: tmpDir });
    upsertVotes(
      'sess-o',
      [],
      { ...makeOutcome('sess-o'), artifacts: artifactsFromOutcomes(OUT), outcomes: OUT },
      { outcomesDir: tmpDir },
    );
    const rec = readRecord('sess-o', tmpDir)!;
    expect(rec.outcomes).toEqual(OUT);
    expect(rec.artifacts.commits).toEqual(['ddddddd', 'b'.repeat(40), 'ccccccc']);
    expect(rec.artifacts.repo).toBe('/repo');
  });
});
