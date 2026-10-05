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
