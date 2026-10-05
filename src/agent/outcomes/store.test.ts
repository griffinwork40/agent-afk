/**
 * Tests for src/agent/outcomes/store.ts
 *
 * All I/O is injected via the outcomesDir parameter — no filesystem access
 * outside a tmp dir, no process.env mutations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRecord, writeRecord, listRecords, upsertVotes } from './store.js';
import type { VerifiedOutcome, Vote } from './schema.js';

// ---------------------------------------------------------------------------
// Test fixtures
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

function makeVote(overrides: Partial<Vote> = {}): Vote {
  return {
    lf: 'test_lf',
    vote: 1,
    strength: 'strong',
    evidence: 'sha:abc',
    observed_at: new Date().toISOString(),
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
    `afk-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readRecord
// ---------------------------------------------------------------------------

describe('readRecord', () => {
  it('returns undefined on miss', () => {
    expect(readRecord('sess-abc', tmpDir)).toBeUndefined();
  });

  it('returns undefined on corrupt JSON', () => {
    const path = join(tmpDir, 'sess-bad.json');
    require('node:fs').writeFileSync(path, 'not json', 'utf8');
    expect(readRecord('sess-bad', tmpDir)).toBeUndefined();
  });

  it('returns undefined on schema-invalid JSON', () => {
    const path = join(tmpDir, 'sess-inv.json');
    require('node:fs').writeFileSync(path, JSON.stringify({ label: 'bad_value' }), 'utf8');
    expect(readRecord('sess-inv', tmpDir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeRecord / atomicity
// ---------------------------------------------------------------------------

describe('writeRecord', () => {
  it('writes and reads back a valid record', () => {
    const outcome = makeOutcome('sess-write');
    writeRecord(outcome, tmpDir);
    const back = readRecord('sess-write', tmpDir);
    expect(back).toEqual(outcome);
  });

  it('writes atomically — no .tmp file left behind', () => {
    const outcome = makeOutcome('sess-atom');
    writeRecord(outcome, tmpDir);
    const tmp = join(tmpDir, `sess-atom.json.${process.pid}.tmp`);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(tmpDir, 'sess-atom.json'))).toBe(true);
  });

  it('produces valid JSON with trailing newline', () => {
    const outcome = makeOutcome('sess-json');
    writeRecord(outcome, tmpDir);
    const raw = readFileSync(join(tmpDir, 'sess-json.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('throws on invalid data (Zod validation)', () => {
    const bad = { ...makeOutcome('sess-z'), label: 'not_a_label' } as unknown as VerifiedOutcome;
    expect(() => writeRecord(bad, tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// listRecords
// ---------------------------------------------------------------------------

describe('listRecords', () => {
  it('returns empty array when dir does not exist', () => {
    expect(listRecords(1000, join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('lists session ids from .json files', () => {
    writeRecord(makeOutcome('sess-a'), tmpDir);
    writeRecord(makeOutcome('sess-b'), tmpDir);
    const ids = listRecords(1000, tmpDir);
    expect(ids).toContain('sess-a');
    expect(ids).toContain('sess-b');
  });

  it('honours the limit bound', () => {
    for (let i = 0; i < 5; i++) writeRecord(makeOutcome(`sess-lim-${i}`), tmpDir);
    const ids = listRecords(3, tmpDir);
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it('skips non-.json entries', () => {
    require('node:fs').writeFileSync(join(tmpDir, 'README.txt'), 'x', 'utf8');
    writeRecord(makeOutcome('sess-real'), tmpDir);
    const ids = listRecords(1000, tmpDir);
    expect(ids).not.toContain('README');
    expect(ids).toContain('sess-real');
  });
});

// ---------------------------------------------------------------------------
// upsertVotes — merge semantics
// ---------------------------------------------------------------------------

describe('upsertVotes – merge and dedupe', () => {
  it('creates a new record when none exists', () => {
    upsertVotes('sess-new', [makeVote()], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-new', tmpDir);
    expect(rec).toBeDefined();
    expect(rec?.votes).toHaveLength(1);
  });

  it('deduplicates by lf+evidence (incoming wins on collision)', () => {
    upsertVotes('sess-dedup', [makeVote({ lf: 'lf_a', evidence: 'sha:1', vote: 1 })], undefined, { outcomesDir: tmpDir });
    upsertVotes('sess-dedup', [makeVote({ lf: 'lf_a', evidence: 'sha:1', vote: -1 })], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-dedup', tmpDir);
    expect(rec?.votes).toHaveLength(1);
    // Incoming -1 replaced the original +1
    expect(rec?.votes[0]?.vote).toBe(-1);
  });

  it('accumulates votes with different lf+evidence without dropping prior ones', () => {
    upsertVotes('sess-acc', [makeVote({ lf: 'lf_a', evidence: 'e1' })], undefined, { outcomesDir: tmpDir });
    upsertVotes('sess-acc', [makeVote({ lf: 'lf_b', evidence: 'e2' })], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-acc', tmpDir);
    expect(rec?.votes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// upsertVotes — history on label change only
// ---------------------------------------------------------------------------

describe('upsertVotes – history', () => {
  it('appends history entry only when label changes', () => {
    // First upsert: unknown → unknown (no change, no history)
    upsertVotes('sess-hist', [makeVote({ vote: 0, strength: 'weak' })], undefined, { outcomesDir: tmpDir });
    let rec = readRecord('sess-hist', tmpDir);
    expect(rec?.history).toHaveLength(0);

    // Second upsert: adds a strong +1 → should change label to succeeded → history entry
    upsertVotes('sess-hist', [makeVote({ lf: 'pr_fate', evidence: 'pr:99', vote: 1, strength: 'strong' })], undefined, { outcomesDir: tmpDir });
    rec = readRecord('sess-hist', tmpDir);
    expect(rec?.label).toBe('succeeded');
    expect(rec?.history).toHaveLength(1);
    expect(rec?.history[0]?.label).toBe('succeeded');
  });

  it('does not append history when label is unchanged', () => {
    upsertVotes('sess-nohist', [makeVote({ lf: 'pr_fate', evidence: 'pr:1', vote: 1, strength: 'strong' })], undefined, { outcomesDir: tmpDir });
    upsertVotes('sess-nohist', [makeVote({ lf: 'ci', evidence: 'ci:1', vote: 1, strength: 'weak' })], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-nohist', tmpDir);
    // Still succeeded (same label) — only the first transition should be recorded
    expect(rec?.history).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsertVotes — explicit_feedback override semantics
// ---------------------------------------------------------------------------

describe('upsertVotes – explicit_feedback override', () => {
  it('/good overrides to succeeded, confidence 1.0, settled', () => {
    upsertVotes('sess-good', [
      makeVote({ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'great work' }),
    ], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-good', tmpDir);
    expect(rec?.label).toBe('succeeded');
    expect(rec?.confidence).toBe(1.0);
    expect(rec?.state).toBe('settled');
  });

  it('/bad overrides to failed, confidence 1.0, settled', () => {
    upsertVotes('sess-bad', [
      makeVote({ lf: 'explicit_feedback', vote: -1, strength: 'strong', evidence: 'wrong answer' }),
    ], undefined, { outcomesDir: tmpDir });
    const rec = readRecord('sess-bad', tmpDir);
    expect(rec?.label).toBe('failed');
    expect(rec?.confidence).toBe(1.0);
    expect(rec?.state).toBe('settled');
  });

  it('later votes are still appended after explicit_feedback', () => {
    // First: good feedback settles the session
    upsertVotes('sess-late', [
      makeVote({ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'good' }),
    ], undefined, { outcomesDir: tmpDir });

    // Later: a revert vote arrives — should be appended but not flip the label
    upsertVotes('sess-late', [
      makeVote({ lf: 'commit_survival', vote: -1, strength: 'strong', evidence: 'sha:rev' }),
    ], undefined, { outcomesDir: tmpDir });

    const rec = readRecord('sess-late', tmpDir);
    // Explicit feedback still wins (succeeded), but the revert vote is in votes[]
    expect(rec?.label).toBe('succeeded');
    expect(rec?.votes.some((v) => v.lf === 'commit_survival')).toBe(true);
    expect(rec?.votes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// upsertVotes — newest explicit_feedback vote wins (issue: stale first-match)
// ---------------------------------------------------------------------------

describe('upsertVotes – newest explicit_feedback vote wins', () => {
  it('/good then /bad-with-note → label is failed (bad wins)', () => {
    // /good with default evidence 'operator'
    upsertVotes('sess-order-1', [
      makeVote({ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'operator',
        observed_at: '2024-01-01T10:00:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    // /bad with a note — different evidence, so both survive dedup
    upsertVotes('sess-order-1', [
      makeVote({ lf: 'explicit_feedback', vote: -1, strength: 'strong', evidence: 'wrong answer',
        observed_at: '2024-01-01T10:01:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    const rec = readRecord('sess-order-1', tmpDir);
    // Newest explicit_feedback is the /bad vote → must be failed, not succeeded
    expect(rec?.label).toBe('failed');
    expect(rec?.confidence).toBe(1.0);
    expect(rec?.state).toBe('settled');
    // Both votes are retained for audit
    expect(rec?.votes.filter((v) => v.lf === 'explicit_feedback')).toHaveLength(2);
  });

  it('/bad-with-note then /good → label is succeeded (good wins)', () => {
    // /bad with a note first
    upsertVotes('sess-order-2', [
      makeVote({ lf: 'explicit_feedback', vote: -1, strength: 'strong', evidence: 'wrong answer',
        observed_at: '2024-01-01T10:00:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    // /good with default evidence 'operator' — newer timestamp
    upsertVotes('sess-order-2', [
      makeVote({ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'operator',
        observed_at: '2024-01-01T10:01:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    const rec = readRecord('sess-order-2', tmpDir);
    // Newest explicit_feedback is the /good vote → must be succeeded
    expect(rec?.label).toBe('succeeded');
    expect(rec?.confidence).toBe(1.0);
    expect(rec?.state).toBe('settled');
    // Both votes retained for audit
    expect(rec?.votes.filter((v) => v.lf === 'explicit_feedback')).toHaveLength(2);
  });

  it('history records the label change when /bad follows /good', () => {
    upsertVotes('sess-hist-flip', [
      makeVote({ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'operator',
        observed_at: '2024-01-01T10:00:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    upsertVotes('sess-hist-flip', [
      makeVote({ lf: 'explicit_feedback', vote: -1, strength: 'strong', evidence: 'wrong answer',
        observed_at: '2024-01-01T10:01:00.000Z' }),
    ], undefined, { outcomesDir: tmpDir });

    const rec = readRecord('sess-hist-flip', tmpDir);
    expect(rec?.label).toBe('failed');
    // History should have two entries: unknown→succeeded and succeeded→failed
    const labels = rec?.history.map((h) => h.label) ?? [];
    expect(labels).toContain('succeeded');
    expect(labels).toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// Legacy first_prompt stripping (issue #2449)
// ---------------------------------------------------------------------------

describe('legacy first_prompt field is stripped on read-modify-write', () => {
  it('upsertVotes removes first_prompt and the raw secret does not appear in the file', () => {
    // Write a raw JSON file simulating a legacy record that has first_prompt
    const legacyRecord = {
      schema_version: 1,
      session_id: 'sess-legacy-strip',
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
      first_prompt: 'secret sk-abcdef12345 fix the login module',
      first_cwd: '/project',
    };
    const legacyPath = join(tmpDir, 'sess-legacy-strip.json');
    writeFileSync(legacyPath, JSON.stringify(legacyRecord) + '\n', 'utf8');

    // Trigger a read-modify-write via upsertVotes
    upsertVotes(
      'sess-legacy-strip',
      [makeVote({ lf: 'test_strip', evidence: 'e1', vote: 0, strength: 'weak' })],
      undefined,
      { outcomesDir: tmpDir },
    );

    // Read the raw file back and assert the secret is gone
    const rawAfter = readFileSync(legacyPath, 'utf8');
    expect(rawAfter).not.toContain('first_prompt');
    expect(rawAfter).not.toContain('sk-abcdef12345');

    // The parsed record should also not have first_prompt
    const rec = readRecord('sess-legacy-strip', tmpDir);
    expect(rec).toBeDefined();
    expect('first_prompt' in (rec ?? {})).toBe(false);
    expect(rec?.first_cwd).toBe('/project'); // first_cwd is kept
  });
});

// ---------------------------------------------------------------------------
// Finding #1: normalClosure from closure_reason (iteration_cap should NOT
// trigger good-by-default rule 6/7)
// ---------------------------------------------------------------------------

describe('upsertVotes – normalClosure derived from closure_reason (finding #1)', () => {
  it('iteration_cap session with one minor vote past window stays unknown (not succeeded 0.3)', () => {
    // An iteration_cap session: closure_reason='iteration_cap' → normalClosure=false
    // Rule 7 (one minor negative past window → succeeded 0.3) only applies
    // when normalClosure is true, so this session must stay unknown.
    const pastWindow = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const base = {
      schema_version: 1 as const,
      session_id: 'sess-iter-cap',
      label: 'unknown' as const,
      confidence: 0,
      state: 'provisional' as const,
      settles_after: pastWindow,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      closure_reason: 'iteration_cap' as const,
    };

    upsertVotes(
      'sess-iter-cap',
      [makeVote({ lf: 'budget_cap', vote: -1, strength: 'weak', severity: 'minor', evidence: 'trace' })],
      base,
      { outcomesDir: tmpDir },
    );

    const rec = readRecord('sess-iter-cap', tmpDir);
    // Must stay unknown — normalClosure=false prevents rule 7 from firing
    expect(rec?.label).toBe('unknown');
    expect(rec?.confidence).toBe(0);
  });

  it('normal-closure session with one minor vote past window → succeeded 0.3 (rule 7)', () => {
    const pastWindow = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const base = {
      schema_version: 1 as const,
      session_id: 'sess-normal-cl',
      label: 'unknown' as const,
      confidence: 0,
      state: 'provisional' as const,
      settles_after: pastWindow,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      closure_reason: 'normal' as const,
    };

    upsertVotes(
      'sess-normal-cl',
      [makeVote({ lf: 'cross_session_reask', vote: -1, strength: 'weak', severity: 'minor', evidence: 'minor' })],
      base,
      { outcomesDir: tmpDir },
    );

    const rec = readRecord('sess-normal-cl', tmpDir);
    // normalClosure=true → rule 7 fires → succeeded 0.3
    expect(rec?.label).toBe('succeeded');
    expect(rec?.confidence).toBe(0.3);
    expect(rec?.basis).toBe('no_bad_signals');
  });

  it('record missing closure_reason (old record) is treated as normal closure', () => {
    // Old records without closure_reason → treated as normal (conservative default)
    const pastWindow = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    // Write a raw record without closure_reason (simulating pre-fix record)
    const legacyRec: VerifiedOutcome = {
      schema_version: 1,
      session_id: 'sess-no-closure',
      label: 'unknown',
      confidence: 0,
      state: 'provisional',
      settles_after: pastWindow,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
    };
    writeRecord(legacyRec, tmpDir);

    // Add one minor negative — with old record (no closure_reason → normal → rule 7)
    upsertVotes(
      'sess-no-closure',
      [makeVote({ lf: 'cross_session_reask', vote: -1, strength: 'weak', severity: 'minor', evidence: 'minor' })],
      undefined,
      { outcomesDir: tmpDir },
    );

    const rec = readRecord('sess-no-closure', tmpDir);
    // absence treated as normal → rule 7 fires → succeeded 0.3
    expect(rec?.label).toBe('succeeded');
  });

  it('closureReason option sets closure_reason on new records', () => {
    upsertVotes(
      'sess-set-reason',
      [],
      {
        schema_version: 1,
        session_id: 'sess-set-reason',
        label: 'unknown',
        confidence: 0,
        state: 'provisional',
        settles_after: null,
        session_kind: 'text',
        self_report: 'none',
        artifacts: { commits: [], prs: [], repo: null },
      },
      { outcomesDir: tmpDir, closureReason: 'iteration_cap' },
    );
    const rec = readRecord('sess-set-reason', tmpDir);
    expect(rec?.closure_reason).toBe('iteration_cap');
  });
});

// ---------------------------------------------------------------------------
// Finding #1 (extended): non-model-end-turn closure reasons are non-normal
// ---------------------------------------------------------------------------

describe('upsertVotes – abnormal closure reasons block good-by-default rules', () => {
  // Invariant: 'truncated', 'timeout', 'budget_exceeded', 'hook_blocked', and
  // 'max_turns_exceeded' from the trace must NOT trigger combiner rules 6/7.
  // closureFromTrace now maps them to 'unknown' (not 'normal'), so normalClosure
  // stays false and the session is not promoted to succeeded.
  const pastWindow = () => new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  for (const abnormalReason of ['unknown', 'abort', 'iteration_cap'] as const) {
    it(`closure_reason='${abnormalReason}' session with minor vote past window stays unknown (rule 6/7 blocked)`, () => {
      const sessionId = `sess-abnormal-${abnormalReason}`;
      const base = {
        schema_version: 1 as const,
        session_id: sessionId,
        label: 'unknown' as const,
        confidence: 0,
        state: 'provisional' as const,
        settles_after: pastWindow(),
        session_kind: 'text' as const,
        self_report: 'none' as const,
        artifacts: { commits: [], prs: [], repo: null },
        closure_reason: abnormalReason,
      };

      upsertVotes(
        sessionId,
        [makeVote({ lf: 'cross_session_reask', vote: -1, strength: 'weak', severity: 'minor', evidence: 'minor' })],
        base,
        { outcomesDir: tmpDir },
      );

      const rec = readRecord(sessionId, tmpDir);
      // abnormal closure → normalClosure=false → rules 6/7 must not fire
      expect(rec?.label).toBe('unknown');
      expect(rec?.closure_reason).toBe(abnormalReason);
    });
  }
});

// ---------------------------------------------------------------------------
// Finding #2: session_ended_at backfill when skeleton was created without base
// ---------------------------------------------------------------------------

describe('upsertVotes – session_ended_at backfill from base (finding #2)', () => {
  it('backfills session_ended_at when existing record (skeleton) lacks it', () => {
    const endedAt = '2025-03-15T08:00:00.000Z';

    // Simulate appendArtifacts creating a skeleton without base (no session_ended_at)
    const skeleton: VerifiedOutcome = {
      schema_version: 1,
      session_id: 'sess-backfill',
      label: 'unknown',
      confidence: 0,
      state: 'provisional',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: ['abc123'], prs: [], repo: null },
      votes: [],
      history: [],
      // Intentionally no session_ended_at — simulates appendArtifacts skeleton
    };
    writeRecord(skeleton, tmpDir);

    // Now session-end hook runs upsertVotes with base carrying session_ended_at
    const base = {
      schema_version: 1 as const,
      session_id: 'sess-backfill',
      label: 'unknown' as const,
      confidence: 0,
      state: 'provisional' as const,
      settles_after: null,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      session_ended_at: endedAt,
      closure_reason: 'normal' as const,
    };

    upsertVotes('sess-backfill', [], base, { outcomesDir: tmpDir });

    const rec = readRecord('sess-backfill', tmpDir);
    // session_ended_at must be backfilled from base into the existing skeleton
    expect(rec?.session_ended_at).toBe(endedAt);
    // closure_reason also backfilled
    expect(rec?.closure_reason).toBe('normal');
  });

  it('does not overwrite existing session_ended_at on re-upsert', () => {
    const originalEndedAt = '2025-01-01T00:00:00.000Z';
    const laterEndedAt = '2025-06-01T00:00:00.000Z';

    const base = {
      schema_version: 1 as const,
      session_id: 'sess-no-overwrite',
      label: 'unknown' as const,
      confidence: 0,
      state: 'provisional' as const,
      settles_after: null,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      session_ended_at: originalEndedAt,
    };

    upsertVotes('sess-no-overwrite', [], base, { outcomesDir: tmpDir });

    // Second upsert with a different session_ended_at in base
    const base2 = { ...base, session_ended_at: laterEndedAt };
    upsertVotes('sess-no-overwrite', [], base2, { outcomesDir: tmpDir });

    const rec = readRecord('sess-no-overwrite', tmpDir);
    // Must not overwrite the original session_ended_at (already present)
    expect(rec?.session_ended_at).toBe(originalEndedAt);
  });
});

// ---------------------------------------------------------------------------
// Finding #3: session_ended_at is written once and preserved across upserts
// ---------------------------------------------------------------------------

describe('upsertVotes – session_ended_at immutability (finding #3)', () => {
  it('session_ended_at is written on first upsert and not overwritten by later upserts', () => {
    const endedAt = '2025-01-01T12:00:00.000Z';

    // First upsert: supplies session_ended_at via base
    upsertVotes(
      'sess-ended-at',
      [],
      {
        schema_version: 1,
        session_id: 'sess-ended-at',
        label: 'unknown',
        confidence: 0,
        state: 'provisional',
        settles_after: null,
        session_kind: 'text',
        self_report: 'none',
        artifacts: { commits: [], prs: [], repo: null },
        session_ended_at: endedAt,
      },
      { outcomesDir: tmpDir },
    );

    // Second upsert: relabel-job style — no session_ended_at in base
    upsertVotes(
      'sess-ended-at',
      [makeVote({ lf: 'ci', vote: 1, strength: 'weak', evidence: 'ci:ok' })],
      undefined,
      { outcomesDir: tmpDir },
    );

    const rec = readRecord('sess-ended-at', tmpDir);
    // session_ended_at must still be the original value, not overwritten
    expect(rec?.session_ended_at).toBe(endedAt);
  });

  it('session_ended_at is present on a freshly created record', () => {
    const endedAt = '2025-06-01T09:00:00.000Z';
    upsertVotes(
      'sess-new-ended',
      [],
      {
        schema_version: 1,
        session_id: 'sess-new-ended',
        label: 'unknown',
        confidence: 0,
        state: 'provisional',
        settles_after: null,
        session_kind: 'text',
        self_report: 'none',
        artifacts: { commits: [], prs: [], repo: null },
        session_ended_at: endedAt,
      },
      { outcomesDir: tmpDir },
    );
    const rec = readRecord('sess-new-ended', tmpDir);
    expect(rec?.session_ended_at).toBe(endedAt);
  });
});
