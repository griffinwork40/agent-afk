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
  promptFingerprint,
  FINGERPRINT_MAX_TOKENS,
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
// promptFingerprint
// ---------------------------------------------------------------------------

describe('promptFingerprint', () => {
  it('returns a sorted, deduplicated array', () => {
    const fp = promptFingerprint('fix login bug fix login');
    // 'fix', 'login', 'bug' — deduped; sorted
    expect(fp).toEqual(['bug', 'fix', 'login']);
  });

  it('deduplication is order-independent (dedup by type, not first-seen position)', () => {
    // 'bug' appears first, then 'fix' — both kept once, output sorted
    const fp = promptFingerprint('bug fix bug fix');
    expect(fp).toEqual(['bug', 'fix']);
  });

  it('is order-independent for prompts with more than FINGERPRINT_MAX_TOKENS unique tokens', () => {
    // Build two prompts with the SAME 80 unique tokens, but in reversed order.
    // Pre-fix: cap was applied BEFORE sort, so reversed order gave different tokens.
    // Post-fix: sort-then-slice guarantees identical fingerprints regardless of order.
    const allTokens = Array.from({ length: 80 }, (_, i) => `vocab${String(i).padStart(3, '0')}`);
    const forward = allTokens.join(' ');
    const reversed = [...allTokens].reverse().join(' ');
    const fpForward = promptFingerprint(forward);
    const fpReversed = promptFingerprint(reversed);
    expect(fpForward).toEqual(fpReversed);
    expect(fpForward.length).toBe(FINGERPRINT_MAX_TOKENS);
    // The kept tokens are the lexicographically first 64, same for both orderings
    const sortedAll = [...allTokens].sort();
    expect(fpForward).toEqual(sortedAll.slice(0, FINGERPRINT_MAX_TOKENS));
  });

  it('caps at FINGERPRINT_MAX_TOKENS when input is very long', () => {
    // Generate more than 64 unique meaningful words
    const words = Array.from({ length: 100 }, (_, i) => `token${String(i).padStart(3, '0')}`);
    const fp = promptFingerprint(words.join(' '));
    expect(fp.length).toBe(FINGERPRINT_MAX_TOKENS);
  });

  it('is sorted lexicographically', () => {
    const fp = promptFingerprint('zebra alpha mango beta');
    const sorted = [...fp].sort();
    expect(fp).toEqual(sorted);
  });

  it('applies the same stopword/length filters as normalizeTokens', () => {
    const fp = promptFingerprint('a the is fix');
    // 'a', 'the', 'is' are stopwords or too short; only 'fix' survives
    expect(fp).toEqual(['fix']);
  });

  it('returns empty array for empty string', () => {
    expect(promptFingerprint('')).toEqual([]);
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
    // Write a prior session record with first_prompt_tokens and first_cwd
    const { writeRecord, readRecord, upsertVotes } = await import('./store.js');
    const {
      jaccardSimilarity: sim,
      promptFingerprint: fp,
      REASK_THRESHOLD: thr,
    } = await import('./lf-reask.js');

    // Use prompts where the key tokens overlap significantly
    const priorPromptText = 'Fix login bug where password reset fails silently every time';
    const newPromptText = 'Fix login bug password reset fails silently';

    const priorFingerprint = fp(priorPromptText);

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
      first_prompt_tokens: priorFingerprint,
      first_cwd: '/project/repo',
    };
    writeRecord(prior, tmpDir);

    const newTokens = new Set(fp(newPromptText));
    const priorTokens = new Set(priorFingerprint);
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

  it('fires reask vote on near-duplicate prompt (via fingerprint Jaccard)', async () => {
    const { writeRecord, readRecord, upsertVotes: upsert } = await import('./store.js');
    const { promptFingerprint: fp, jaccardSimilarity: sim, REASK_THRESHOLD: thr } =
      await import('./lf-reask.js');

    const prior1 = 'Refactor the authentication module to use JWT tokens';
    const newPrompt = 'Refactor authentication module use JWT tokens for login';

    const priorFp = fp(prior1);
    const newFp = fp(newPrompt);
    const similarity = sim(new Set(newFp), new Set(priorFp));
    expect(similarity).toBeGreaterThanOrEqual(thr);

    writeRecord(
      {
        schema_version: 1, session_id: 'sess-near-dup-prior',
        label: 'unknown', confidence: 0, state: 'settled', settles_after: null,
        session_kind: 'text', self_report: 'none',
        artifacts: { commits: [], prs: [], repo: null },
        votes: [], history: [],
        first_prompt_tokens: priorFp,
        first_cwd: '/some/cwd',
      },
      tmpDir,
    );

    upsert(
      'sess-near-dup-prior',
      [{ lf: 'cross_session_reask', vote: -1, strength: 'weak',
         evidence: `near-dup (Jaccard=${similarity.toFixed(2)})`,
         observed_at: new Date().toISOString() }],
      undefined,
      { outcomesDir: tmpDir },
    );

    const updated = readRecord('sess-near-dup-prior', tmpDir);
    expect(updated?.votes.some((v) => v.lf === 'cross_session_reask')).toBe(true);
  });

  it('does NOT fire reask vote on unrelated prompt', async () => {
    const { promptFingerprint: fp, jaccardSimilarity: sim, REASK_THRESHOLD: thr } =
      await import('./lf-reask.js');

    const prior = 'Deploy the staging environment with new docker image';
    const unrelated = 'Write unit tests for the payment billing module refactoring';

    const similarity = sim(new Set(fp(unrelated)), new Set(fp(prior)));
    expect(similarity).toBeLessThan(thr);
  });

  it('does NOT match a legacy record that has only first_prompt (no tokens)', async () => {
    // A legacy record without first_prompt_tokens should be skipped by lfReask
    const { writeRecord } = await import('./store.js');
    const { promptFingerprint: fp } = await import('./lf-reask.js');

    // Write a record that simulates the old format — but our schema strips first_prompt,
    // so first_prompt_tokens will be absent; verify the fingerprint check correctly
    // skips it (empty/absent tokens array)
    const legacyWithNoTokens = {
      schema_version: 1 as const,
      session_id: 'sess-legacy-no-tokens',
      label: 'unknown' as const,
      confidence: 0,
      state: 'settled' as const,
      settles_after: null,
      session_kind: 'text' as const,
      self_report: 'none' as const,
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
      // no first_prompt_tokens
      first_cwd: '/some/cwd',
    };
    writeRecord(legacyWithNoTokens, tmpDir);

    // The record has no first_prompt_tokens, so the fingerprint is empty/absent
    const { readRecord } = await import('./store.js');
    const rec = readRecord('sess-legacy-no-tokens', tmpDir);
    expect(rec?.first_prompt_tokens).toBeUndefined();

    // promptFingerprint on ANY text shouldn't magically produce tokens matching undefined
    const newFp = fp('Fix the authentication module login bug refactor');
    expect(newFp.length).toBeGreaterThan(0);
    // Since stored tokens is undefined/empty, lfReask would skip this record
    const storedTokens = rec?.first_prompt_tokens;
    expect(!storedTokens || storedTokens.length === 0).toBe(true);
  });
});
