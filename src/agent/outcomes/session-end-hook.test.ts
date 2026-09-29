/**
 * Tests for src/agent/outcomes/session-end-hook.ts
 *
 * The hook itself is fire-and-forget; tests verify:
 *   - It skips subagent contexts
 *   - It skips missing sessionId
 *   - The internal _runImmediatePass logic via the pure parts it calls
 *   - appendArtifacts merges correctly (store integration)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOutcomeSessionEndHook } from './session-end-hook.js';
import { readRecord, writeRecord, appendArtifacts } from './store.js';
import type { VerifiedOutcome } from './schema.js';

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
