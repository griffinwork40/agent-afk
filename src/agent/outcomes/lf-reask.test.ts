/**
 * Tests for lf-reask.ts — cross_session_reask labeling function.
 *
 * All I/O is injected via the outcomesDir parameter where possible.
 * The lfReask function uses getOutcomesDir() internally, so tests that
 * need to call it use a real temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeTokens,
  jaccardSimilarity,
  REASK_THRESHOLD,
} from './lf-reask.js';

// ---------------------------------------------------------------------------
// normalizeTokens
// ---------------------------------------------------------------------------

describe('normalizeTokens', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    const tokens = normalizeTokens('Hello, World! This is a TEST.');
    expect(tokens.has('hello')).toBe(true);
    expect(tokens.has('world')).toBe(true);
    expect(tokens.has('test')).toBe(true);
  });

  it('removes stopwords', () => {
    const tokens = normalizeTokens('this is a the and in');
    // All of these are stopwords — result should be empty
    expect(tokens.size).toBe(0);
  });

  it('removes single-character tokens', () => {
    const tokens = normalizeTokens('a b c do something x');
    expect(tokens.has('a')).toBe(false);
    expect(tokens.has('b')).toBe(false);
    expect(tokens.has('something')).toBe(true);
  });

  it('deduplicates repeated tokens', () => {
    const tokens = normalizeTokens('fix fix fix the bug bug');
    expect(tokens.has('fix')).toBe(true);
    expect(tokens.has('bug')).toBe(true);
    expect(tokens.size).toBe(2);
  });

  it('returns empty set for empty string', () => {
    expect(normalizeTokens('').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['fix', 'bug', 'auth']);
    expect(jaccardSimilarity(a, a)).toBe(1.0);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['foo', 'bar']);
    const b = new Set(['baz', 'qux']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('computes partial overlap correctly', () => {
    const a = new Set(['fix', 'bug', 'auth', 'login']);
    const b = new Set(['fix', 'bug', 'register', 'password']);
    // intersection = {fix, bug} = 2; union = 6
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 6);
  });

  it('threshold REASK_THRESHOLD is 0.6', () => {
    expect(REASK_THRESHOLD).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Integration: similar prompts exceed threshold
// ---------------------------------------------------------------------------

describe('prompt similarity for reask detection', () => {
  it('recognizes an identical prompt as 1.0 similarity (above threshold)', () => {
    const prompt = 'Fix login bug password reset fails silently';
    const a = normalizeTokens(prompt);
    const b = normalizeTokens(prompt);
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBe(1.0);
    expect(sim).toBeGreaterThanOrEqual(REASK_THRESHOLD);
  });

  it('does not match unrelated prompts', () => {
    const a = normalizeTokens('Add unit tests for the payment module');
    const b = normalizeTokens('Update the README documentation for deployment');
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBeLessThan(REASK_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// appendArtifacts and store integration
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-reask-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('lfReask store interaction', () => {
  it('does not throw when outcomesDir is empty', async () => {
    // lfReask uses the default outcomesDir, so we just verify it does not throw
    // when called with a prompt that has no matching prior sessions.
    const { lfReask } = await import('./lf-reask.js');
    expect(() =>
      lfReask('sess-new-1', 'Fix auth bug with login', '/some/cwd', new Date().toISOString()),
    ).not.toThrow();
  });

  it('upserts reask vote onto matching prior session in custom dir', async () => {
    // Write a prior session record with first_prompt and first_cwd
    const { writeRecord, readRecord, upsertVotes } = await import('./store.js');
    const { jaccardSimilarity: sim, normalizeTokens: norm, REASK_THRESHOLD: thr } =
      await import('./lf-reask.js');

    // Use prompts where the key tokens overlap significantly
    const priorPromptText = 'Fix login bug where password reset fails silently every time';
    const newPromptText = 'Fix login bug password reset fails silently';

    const prior = {
      schema_version: 1 as const,
      session_id: 'sess-prior-1',
      label: 'unknown' as const,
      confidence: 0,
      state: 'settled' as const,
      settles_after: null,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
      first_prompt: priorPromptText,
      first_cwd: '/project/repo',
    };
    writeRecord(prior, tmpDir);

    const newTokens = norm(newPromptText);
    const priorTokens = norm(priorPromptText);
    const similarity = sim(newTokens, priorTokens);

    // Verify the similarity IS above threshold before testing the vote logic
    expect(similarity).toBeGreaterThanOrEqual(thr);

    upsertVotes(
      prior.session_id,
      [
        {
          lf: 'cross_session_reask',
          vote: -1,
          strength: 'weak',
          evidence: `new session sess-new-2 in same cwd (Jaccard=${similarity.toFixed(2)})`,
          observed_at: new Date().toISOString(),
        },
      ],
      undefined,
      { outcomesDir: tmpDir },
    );

    const updated = readRecord('sess-prior-1', tmpDir);
    expect(updated).toBeDefined();
    expect(updated?.votes.some((v) => v.lf === 'cross_session_reask')).toBe(true);
    expect(updated?.votes.find((v) => v.lf === 'cross_session_reask')?.vote).toBe(-1);
  });
});
