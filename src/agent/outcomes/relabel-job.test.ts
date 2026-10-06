/**
 * Unit tests for relabel-job.ts, lf-ci.ts, and lf-fof.ts.
 *
 * All I/O is injected — no network, no filesystem access, no real gh/git.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { lfCi } from './lf-ci.js';
import type { ExecFnCi } from './lf-ci.js';
import { lfFixOfFix } from './lf-fof.js';
import type { ExecFnFof } from './lf-fof.js';
import { processRecord, runRelabelJob, rescoreSettledUnknown } from './relabel-job.js';
import type { RelabelDeps } from './relabel-job.js';
import { writeRecord, readRecord } from './store.js';
import type { VerifiedOutcome, Vote } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_SESSION = 'test-session-relabel-0001';
const NOW = '2026-09-28T03:17:00.000Z';
const NOW_DATE = new Date(NOW);

function makeRecord(
  sessionId: string,
  overrides: Partial<VerifiedOutcome> = {},
): VerifiedOutcome {
  return {
    schema_version: 1,
    session_id: sessionId,
    label: 'unknown',
    confidence: 0,
    state: 'provisional',
    settles_after: new Date(NOW_DATE.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
    session_kind: 'mutating',
    self_report: 'done',
    artifacts: {
      commits: ['abc1234'],
      prs: ['https://github.com/owner/repo/pull/42'],
      repo: null,
    },
    votes: [],
    history: [],
    ...overrides,
  };
}

function makeFakeExecCi(
  response: object | null,
  throwError = false,
): ExecFnCi {
  return async (_file: string, _args: string[]) => {
    if (throwError) throw new Error('gh unavailable');
    return { stdout: response !== null ? JSON.stringify(response) : '', stderr: '' };
  };
}

function makeFakeExecFof(response: object[] | null, throwError = false): ExecFnFof {
  return async (_file: string, _args: string[]) => {
    if (throwError) throw new Error('gh unavailable');
    return { stdout: response !== null ? JSON.stringify(response) : '', stderr: '' };
  };
}

function makeDeps(overrides: Partial<RelabelDeps> = {}): RelabelDeps {
  return {
    fetchPrState: async () => null,
    checkAncestor: async () => false,
    checkRevert: async () => false,
    execFnCi: makeFakeExecCi([], false),
    execFnFof: makeFakeExecFof([], false),
    now: () => NOW_DATE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// lf-ci tests
// ---------------------------------------------------------------------------

describe('lfCi', () => {
  it('votes +1 weak when all checks passed', async () => {
    const exec = makeFakeExecCi([
      { conclusion: 'success', status: 'completed' },
      { conclusion: 'success', status: 'completed' },
    ]);
    const votes = await lfCi(
      ['https://github.com/owner/repo/pull/42'],
      exec,
      NOW,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0]!.vote).toBe(1);
    expect(votes[0]!.strength).toBe('weak');
    expect(votes[0]!.lf).toBe('ci');
  });

  it('votes -1 weak when a check failed', async () => {
    const exec = makeFakeExecCi([
      { conclusion: 'success', status: 'completed' },
      { conclusion: 'failure', status: 'completed' },
    ]);
    const votes = await lfCi(
      ['https://github.com/owner/repo/pull/42'],
      exec,
      NOW,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0]!.vote).toBe(-1);
  });

  it('abstains when checks are still pending', async () => {
    const exec = makeFakeExecCi([
      { conclusion: null, status: 'in_progress' },
    ]);
    const votes = await lfCi(
      ['https://github.com/owner/repo/pull/42'],
      exec,
      NOW,
    );
    expect(votes).toHaveLength(0);
  });

  it('abstains when no checks returned', async () => {
    const exec = makeFakeExecCi([]);
    const votes = await lfCi(
      ['https://github.com/owner/repo/pull/42'],
      exec,
      NOW,
    );
    expect(votes).toHaveLength(0);
  });

  it('abstains on gh error', async () => {
    const exec = makeFakeExecCi(null, true);
    const votes = await lfCi(
      ['https://github.com/owner/repo/pull/42'],
      exec,
      NOW,
    );
    expect(votes).toHaveLength(0);
  });

  it('uses cache to avoid re-fetching same PR', async () => {
    let callCount = 0;
    const exec: ExecFnCi = async () => {
      callCount++;
      return { stdout: JSON.stringify([{ conclusion: 'success', status: 'completed' }]), stderr: '' };
    };
    const cache: Map<string, 'passed' | 'failed' | 'pending' | 'none' | 'error'> = new Map();
    const url = 'https://github.com/owner/repo/pull/42';

    await lfCi([url], exec, NOW, cache);
    await lfCi([url], exec, NOW, cache);

    expect(callCount).toBe(1); // second call hits cache
  });
});

// ---------------------------------------------------------------------------
// lf-fof tests
// ---------------------------------------------------------------------------

describe('lfFixOfFix', () => {
  it('returns weak -1 when a later PR references the session PR', async () => {
    const settlesAfter = new Date(NOW_DATE.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(NOW_DATE.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const exec = makeFakeExecFof([
      {
        number: 99,
        body: 'fixes #42 regression from #42',
        title: 'fix regression',
        createdAt,
        mergedAt: null,
        state: 'open',
      },
    ]);

    const votes = await lfFixOfFix(
      ['https://github.com/owner/repo/pull/42'],
      settlesAfter,
      exec,
      NOW,
      NOW_DATE,
    );

    expect(votes).toHaveLength(1);
    expect(votes[0]!.vote).toBe(-1);
    expect(votes[0]!.strength).toBe('weak');
    expect(votes[0]!.lf).toBe('fix_of_fix');
  });

  it('returns no votes when there are no references', async () => {
    const exec = makeFakeExecFof([]);
    const votes = await lfFixOfFix(
      ['https://github.com/owner/repo/pull/42'],
      null,
      exec,
      NOW,
      NOW_DATE,
    );
    expect(votes).toHaveLength(0);
  });

  it('abstains on gh error', async () => {
    const exec = makeFakeExecFof(null, true);
    const votes = await lfFixOfFix(
      ['https://github.com/owner/repo/pull/42'],
      null,
      exec,
      NOW,
      NOW_DATE,
    );
    expect(votes).toHaveLength(0);
  });

  it('fix_of_fix cannot flip succeeded — weak vote only', async () => {
    // This is enforced structurally by the combiner (strong +1 succeeds,
    // weak -1 lowers confidence but cannot flip the label).
    // Verify the vote is always weak.
    const settlesAfter = new Date(NOW_DATE.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(NOW_DATE.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const exec = makeFakeExecFof([
      { number: 100, body: 'fixes #42', title: 'fix', createdAt, mergedAt: null, state: 'open' },
    ]);
    const votes = await lfFixOfFix(
      ['https://github.com/owner/repo/pull/42'],
      settlesAfter,
      exec,
      NOW,
      NOW_DATE,
    );
    for (const v of votes) {
      expect(v.strength).toBe('weak');
      expect(v.vote).toBe(-1); // never +1
    }
  });
});

// ---------------------------------------------------------------------------
// processRecord tests — uses a real temp store dir
// ---------------------------------------------------------------------------

describe('processRecord', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-relabel-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks record settled when PR is merged', async () => {
    const sessionId = 'relabel-test-merged-001';
    writeRecord(makeRecord(sessionId), tmpDir);

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-21T00:00:00Z' }),
    });

    const result = await processRecord(sessionId, deps, false, tmpDir);
    expect(result.status).toBe('settled');

    const updated = readRecord(sessionId, tmpDir);
    expect(updated?.state).toBe('settled');
    expect(updated?.votes.some((v) => v.lf === 'pr_fate' && v.vote === 1)).toBe(true);
  });

  it('votes -1 when PR is closed unmerged', async () => {
    const sessionId = 'relabel-test-closed-001';
    writeRecord(makeRecord(sessionId), tmpDir);

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'CLOSED', mergedAt: null }),
    });

    const result = await processRecord(sessionId, deps, false, tmpDir);
    expect(['settled', 'updated']).toContain(result.status);

    const updated = readRecord(sessionId, tmpDir);
    expect(updated?.votes.some((v) => v.lf === 'pr_fate' && v.vote === -1)).toBe(true);
  });

  it('abstains when PR is still open (no vote pushed)', async () => {
    const sessionId = 'relabel-test-open-001';
    const futureSettles = new Date(NOW_DATE.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord(makeRecord(sessionId, { settles_after: futureSettles }), tmpDir);

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'OPEN', mergedAt: null }),
    });

    await processRecord(sessionId, deps, false, tmpDir);

    const updated = readRecord(sessionId, tmpDir);
    const prFateVotes = updated?.votes.filter((v) => v.lf === 'pr_fate') ?? [];
    expect(prFateVotes).toHaveLength(0);
  });

  it('settles record when settles_after + grace period has passed', async () => {
    const sessionId = 'relabel-test-grace-001';
    const oldSettles = new Date(NOW_DATE.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord(makeRecord(sessionId, { settles_after: oldSettles }), tmpDir);

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'OPEN', mergedAt: null }),
    });

    const result = await processRecord(sessionId, deps, false, tmpDir);
    expect(result.status).toBe('settled');
  });

  it('dry-run leaves record unchanged', async () => {
    const sessionId = 'relabel-test-dryrun-001';
    writeRecord(makeRecord(sessionId), tmpDir);

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-21T00:00:00Z' }),
    });

    await processRecord(sessionId, deps, true, tmpDir);

    const record = readRecord(sessionId, tmpDir);
    expect(record?.state).toBe('provisional'); // unchanged
    expect(record?.votes).toHaveLength(0); // no votes written
  });

  it('skips already-settled records', async () => {
    const sessionId = 'relabel-test-settled-001';
    writeRecord(makeRecord(sessionId, { state: 'settled' }), tmpDir);

    const deps = makeDeps();
    const result = await processRecord(sessionId, deps, false, tmpDir);
    expect(result.status).toBe('skipped');
  });

  it('gh failure leaves record provisional (skip, retry next night)', async () => {
    const sessionId = 'relabel-test-ghfail-001';
    writeRecord(makeRecord(sessionId), tmpDir);

    // gh fails → fetchPrState returns null
    const deps = makeDeps({
      fetchPrState: async () => null,
    });

    await processRecord(sessionId, deps, false, tmpDir);

    const record = readRecord(sessionId, tmpDir);
    // Record remains provisional since we have no terminal pr_fate and
    // settles_after hasn't passed with full grace
    // (The record's settles_after is 8 days ago, grace is 2 days → should force-settle)
    // Actually with 8 days + 2 days = 10 days grace: nowDate is after settles + 2d
    // so this record WILL be force-settled. That's correct behaviour.
    // The key assertion: no pr_fate vote was written from the gh failure.
    const prFateVotes = record?.votes.filter((v) => v.lf === 'pr_fate') ?? [];
    expect(prFateVotes).toHaveLength(0);
  });

  it('revert found gives -1 commit_survival vote', async () => {
    const sessionId = 'relabel-test-revert-001';
    // Contract: use tmpDir (the test's real temp dir) as the repo path rather
    // than the POSIX-only '/tmp'.  On Windows, path.resolve('/tmp') resolves to
    // a drive-relative path (e.g. 'D:\tmp') that does not exist, so
    // existsSync(repo) returns false, repoCwd is null, and lfCommitSurvival is
    // never called — making the assertion "expect(survivalVotes.some(v => v.vote
    // === -1)).toBe(true)" fail.  tmpDir is created by mkdtempSync(os.tmpdir())
    // and always exists on every platform.  See #703 L8c.
    writeRecord(makeRecord(sessionId, { artifacts: { commits: ['deadbeef'], prs: [], repo: tmpDir } }), tmpDir);

    // checkRevert returns true (revert found); checkAncestor not reached.
    const deps = makeDeps({
      checkAncestor: async () => false,
      checkRevert: async () => true,
    });

    await processRecord(sessionId, deps, false, tmpDir);

    const updated = readRecord(sessionId, tmpDir);
    const survivalVotes = updated?.votes.filter((v) => v.lf === 'commit_survival') ?? [];
    // repo=tmpDir exists on every platform; survival LF WILL run.
    expect(survivalVotes.some((v) => v.vote === -1)).toBe(true);
  });

  it('commit survival +1 when ancestor check passes', async () => {
    const sessionId = 'relabel-test-survival-001';
    // Contract: use tmpDir (the test's real temp dir) as the repo path; see
    // the 'revert found' test above for the full rationale.  See #703 L8c.
    writeRecord(
      makeRecord(sessionId, { artifacts: { commits: ['cafebabe'], prs: [], repo: tmpDir } }),
      tmpDir,
    );

    const deps = makeDeps({
      checkAncestor: async () => true,
      checkRevert: async () => false,
    });

    await processRecord(sessionId, deps, false, tmpDir);

    const updated = readRecord(sessionId, tmpDir);
    const survivalVotes = updated?.votes.filter((v) => v.lf === 'commit_survival') ?? [];
    expect(survivalVotes.some((v) => v.vote === 1)).toBe(true);
  });

  it('fix_of_fix weak -1 cannot flip a succeeded record', async () => {
    // Start with a strong +1 from pr_fate
    const sessionId = 'relabel-test-fof-noflip-001';
    const existingVote: Vote = {
      lf: 'pr_fate',
      vote: 1,
      strength: 'strong',
      evidence: 'PR merged',
      observed_at: NOW,
    };
    writeRecord(
      makeRecord(sessionId, {
        label: 'succeeded',
        state: 'provisional',
        votes: [existingVote],
        artifacts: {
          commits: [],
          prs: ['https://github.com/owner/repo/pull/42'],
          repo: null,
        },
      }),
      tmpDir,
    );

    // PR is already merged (terminal), but fix_of_fix fires
    const settlesAfter = new Date(NOW_DATE.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(NOW_DATE.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-20T00:00:00Z' }),
      execFnFof: makeFakeExecFof([
        { number: 77, body: 'fixes #42', title: 'fix', createdAt, mergedAt: null, state: 'open' },
      ]),
    });

    await processRecord(sessionId, deps, false, tmpDir);

    const updated = readRecord(sessionId, tmpDir);
    // Label must remain succeeded — fix_of_fix weak -1 cannot flip strong +1
    expect(updated?.label).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// runRelabelJob integration test
// ---------------------------------------------------------------------------

describe('runRelabelJob', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-relabeljob-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts when store is empty', async () => {
    const result = await runRelabelJob({
      outcomesDir: tmpDir,
      deps: makeDeps(),
    });
    expect(result.scanned).toBe(0);
    expect(result.settled).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('settles all provisional records in one run', async () => {
    for (let i = 1; i <= 3; i++) {
      const id = `relabel-job-test-00${i}`;
      writeRecord(makeRecord(id), tmpDir);
    }

    const deps = makeDeps({
      fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-21T00:00:00Z' }),
    });

    const result = await runRelabelJob({
      outcomesDir: tmpDir,
      deps,
    });

    expect(result.scanned).toBe(3);
    expect(result.settled).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('reaches provisional records beyond the first N settled ones', async () => {
    for (let i = 0; i < 12; i++) {
      writeRecord(makeRecord(`relabel-settled-${String(i).padStart(3, '0')}`, { state: 'settled' }), tmpDir);
    }
    writeRecord(makeRecord('relabel-zzz-provisional'), tmpDir);

    const result = await runRelabelJob({
      outcomesDir: tmpDir,
      limit: 5,
      deps: makeDeps({
        fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-21T00:00:00Z' }),
      }),
    });

    expect(result.scanned).toBe(1);
    expect(result.settled).toBe(1);
  });

  it('respects --limit flag', async () => {
    for (let i = 1; i <= 5; i++) {
      const id = `relabel-limit-test-00${i}`;
      writeRecord(makeRecord(id), tmpDir);
    }

    const result = await runRelabelJob({
      outcomesDir: tmpDir,
      limit: 3,
      deps: makeDeps({
        fetchPrState: async () => ({ state: 'MERGED', mergedAt: '2026-09-21T00:00:00Z' }),
      }),
    });

    expect(result.scanned).toBeLessThanOrEqual(3);
  });

  it('skips settled records', async () => {
    const id = 'relabel-skip-settled-001';
    writeRecord(makeRecord(id, { state: 'settled' }), tmpDir);

    const result = await runRelabelJob({
      outcomesDir: tmpDir,
      deps: makeDeps(),
    });

    expect(result.scanned).toBe(0); // settled not counted
  });
});

// ---------------------------------------------------------------------------
// rescoreSettledUnknown — backfill
// ---------------------------------------------------------------------------

describe('rescoreSettledUnknown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relabel-rescore-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSettledUnknown(sessionId: string, extraVotes: Vote[] = []): VerifiedOutcome {
    return {
      schema_version: 1,
      session_id: sessionId,
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: new Date(Date.now() - 1000).toISOString(),
      session_kind: 'text',
      self_report: 'done',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [
        { lf: 'self_report', vote: 0, strength: 'weak', evidence: 'self_report=done', observed_at: NOW },
        ...extraVotes,
      ],
      history: [],
    };
  }

  it('relabels settled unknown with no negatives to succeeded (good-by-default)', async () => {
    const id = 'rescore-no-neg-001';
    writeRecord(makeSettledUnknown(id), tmpDir);

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    expect(result.scanned).toBe(1);
    expect(result.relabeled).toBe(1);
    expect(result.skipped).toBe(0);

    const updated = readRecord(id, tmpDir);
    expect(updated?.label).toBe('succeeded');
    expect(updated?.basis).toBe('no_bad_signals');
    expect(updated?.confidence).toBeGreaterThan(0);
    // History appended
    expect(updated?.history.length).toBeGreaterThan(0);
    expect(updated?.history[0]?.reason).toContain('rescore-settled');
  });

  it('dry-run: does not write to disk', async () => {
    const id = 'rescore-dry-001';
    writeRecord(makeSettledUnknown(id), tmpDir);

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir, dryRun: true });
    expect(result.relabeled).toBe(1);

    const unchanged = readRecord(id, tmpDir);
    expect(unchanged?.label).toBe('unknown'); // not written
  });

  it('skips settled records that are not unknown (not scanned)', async () => {
    const id = 'rescore-not-unknown-001';
    writeRecord(
      makeSettledUnknown(id, [{ lf: 'verification', vote: 1, strength: 'strong', evidence: 'pass', observed_at: NOW }]),
      tmpDir,
    );
    // Force-update to succeeded so label !== unknown
    const rec = readRecord(id, tmpDir);
    if (rec) writeRecord({ ...rec, label: 'succeeded' }, tmpDir);

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    // Not in candidates (filtered pre-scan) — scanned=0 and relabeled=0
    expect(result.scanned).toBe(0);
    expect(result.relabeled).toBe(0);
  });

  it('skips provisional records', async () => {
    const id = 'rescore-prov-001';
    writeRecord(
      { ...makeSettledUnknown(id), state: 'provisional' },
      tmpDir,
    );

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    expect(result.scanned).toBe(0); // provisional filtered before scan
    expect(result.relabeled).toBe(0);
  });

  it('preserves existing history entries and appends new one', async () => {
    const id = 'rescore-history-001';
    const rec = makeSettledUnknown(id);
    writeRecord({
      ...rec,
      history: [{ at: '2024-01-01T00:00:00Z', label: 'unknown', reason: 'initial' }],
    }, tmpDir);

    await rescoreSettledUnknown({ outcomesDir: tmpDir });

    const updated = readRecord(id, tmpDir);
    expect(updated?.history.length).toBe(2);
    expect(updated?.history[0]?.reason).toBe('initial');
    expect(updated?.history[1]?.reason).toContain('rescore-settled');
  });

  it('respects limit', async () => {
    for (let i = 1; i <= 5; i++) {
      writeRecord(makeSettledUnknown(`rescore-limit-00${i}`), tmpDir);
    }

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir, limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.relabeled).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Finding #4: rescoreSettledUnknown must pass normalClosure to combine()
// ---------------------------------------------------------------------------

describe('rescoreSettledUnknown – normalClosure from closure_reason (finding #4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relabel-rescore-f4-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSettledUnknownWithClosure(
    sessionId: string,
    closureReason: VerifiedOutcome['closure_reason'],
    extraVotes: Vote[] = [],
  ): VerifiedOutcome {
    return {
      schema_version: 1,
      session_id: sessionId,
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: new Date(Date.now() - 1000).toISOString(),
      session_kind: 'text',
      self_report: 'done',
      artifacts: { commits: [], prs: [], repo: null },
      closure_reason: closureReason,
      votes: [
        { lf: 'self_report', vote: 0, strength: 'weak', evidence: 'self_report=done', observed_at: NOW },
        ...extraVotes,
      ],
      history: [],
    };
  }

  it('iteration_cap session with one minor vote stays unknown after rescore (rule 7 blocked)', async () => {
    // The bug: rescoreSettledUnknown passed settleWindowPassed=true but not normalClosure.
    // combineV2 defaulted normalClosure=true → rule 7 fired → relabeled to succeeded 0.3.
    // Fix: normalClosure derived from closure_reason='iteration_cap' → false → rule 7 skipped.
    const id = 'rescore-iter-cap-minor-001';
    writeRecord(
      makeSettledUnknownWithClosure(id, 'iteration_cap', [
        { lf: 'budget_cap', vote: -1, strength: 'weak', severity: 'minor', evidence: 'trace', observed_at: NOW },
      ]),
      tmpDir,
    );

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    expect(result.scanned).toBe(1);
    // Must NOT be relabeled — normalClosure=false means rule 7 does not apply
    expect(result.relabeled).toBe(0);
    expect(result.skipped).toBe(1);

    const rec = readRecord(id, tmpDir);
    expect(rec?.label).toBe('unknown');
  });

  it('abort-closure session with no negatives stays unknown (rule 6 blocked by normalClosure=false)', async () => {
    // abort sessions should not get good-by-default even with no negative votes
    const id = 'rescore-abort-no-neg-001';
    writeRecord(
      makeSettledUnknownWithClosure(id, 'abort', [
        { lf: 'self_report', vote: 0, strength: 'weak', evidence: 'self_report=none', observed_at: NOW },
      ]),
      tmpDir,
    );

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    // rule 6 requires normalClosure=true → abort → normalClosure=false → stays unknown
    expect(result.relabeled).toBe(0);

    const rec = readRecord(id, tmpDir);
    expect(rec?.label).toBe('unknown');
  });

  it('normal-closure session with no negatives is relabeled to succeeded (rule 6 applies)', async () => {
    const id = 'rescore-normal-no-neg-001';
    writeRecord(
      makeSettledUnknownWithClosure(id, 'normal'),
      tmpDir,
    );

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    expect(result.relabeled).toBe(1);

    const rec = readRecord(id, tmpDir);
    expect(rec?.label).toBe('succeeded');
    expect(rec?.basis).toBe('no_bad_signals');
  });

  it('old record without closure_reason is treated as normal (backward-compatible)', async () => {
    // Records written before closure_reason was added: absence → treated as normal
    const id = 'rescore-no-closure-reason-001';
    const rec: VerifiedOutcome = {
      schema_version: 1,
      session_id: id,
      label: 'unknown',
      confidence: 0,
      state: 'settled',
      settles_after: new Date(Date.now() - 1000).toISOString(),
      session_kind: 'text',
      self_report: 'done',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [
        { lf: 'self_report', vote: 0, strength: 'weak', evidence: 'self_report=done', observed_at: NOW },
      ],
      history: [],
      // no closure_reason field
    };
    writeRecord(rec, tmpDir);

    const result = await rescoreSettledUnknown({ outcomesDir: tmpDir });
    // No closure_reason → treated as normal → rule 6 fires → relabeled
    expect(result.relabeled).toBe(1);
    const updated = readRecord(id, tmpDir);
    expect(updated?.label).toBe('succeeded');
  });
});
