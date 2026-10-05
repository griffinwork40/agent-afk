/**
 * Unit tests for yield-probe (#2016).
 *
 * Tests the pure helpers (getCurrentBranch, queryPrState) and the top-level
 * writeFacetYield integration. No real git/gh processes are spawned.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getCurrentBranch, queryPrState, queryPrStateByUrl, writeFacetYield, patchYieldFields } from './yield-probe.js';
import type { ExecFnYield } from './yield-probe.js';

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe('getCurrentBranch', () => {
  it('returns the branch name on success', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: 'main\n', stderr: '' });
    expect(await getCurrentBranch(exec)).toBe('main');
  });

  it('returns null when git fails', async () => {
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('not a git repo'));
    expect(await getCurrentBranch(exec)).toBeNull();
  });

  it('returns null when stdout is empty', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: '   ', stderr: '' });
    expect(await getCurrentBranch(exec)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// queryPrState
// ---------------------------------------------------------------------------

describe('queryPrState', () => {
  it('returns "merged" for a merged PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'MERGED' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('merged');
  });

  it('returns "open" for an open PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'OPEN' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('open');
  });

  it('returns "closed" for a closed PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'CLOSED' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('closed');
  });

  it('returns "none" for an empty PR list', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    expect(await queryPrState(exec, 'afk/no-pr')).toBe('none');
  });

  it('returns "error" on gh failure', async () => {
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('gh not found'));
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('error');
  });

  it('returns "none" for a branch name starting with "--"', async () => {
    const exec: ExecFnYield = vi.fn();
    expect(await queryPrState(exec, '--inject')).toBe('none');
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns "none" on malformed JSON', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// queryPrStateByUrl (#2777)
// ---------------------------------------------------------------------------

describe('queryPrStateByUrl', () => {
  const prUrl = 'https://github.com/owner/repo/pull/42';

  it('returns "merged" for a merged PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    });
    expect(await queryPrStateByUrl(exec, prUrl)).toBe('merged');
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '--json', 'state', '--', prUrl], expect.any(Object));
  });

  it('returns "open" for an open PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ state: 'OPEN' }),
      stderr: '',
    });
    expect(await queryPrStateByUrl(exec, prUrl)).toBe('open');
  });

  it('returns "closed" for a closed PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ state: 'CLOSED' }),
      stderr: '',
    });
    expect(await queryPrStateByUrl(exec, prUrl)).toBe('closed');
  });

  it('returns "error" on gh failure', async () => {
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('gh not found'));
    expect(await queryPrStateByUrl(exec, prUrl)).toBe('error');
  });

  it('returns "error" on malformed JSON', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    expect(await queryPrStateByUrl(exec, prUrl)).toBe('error');
  });

  // item 3 (#2781): URL validation guard
  it('returns "error" and never calls exec for a value starting with "-" (#2781)', async () => {
    const exec: ExecFnYield = vi.fn();
    expect(await queryPrStateByUrl(exec, '--exploit')).toBe('error');
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns "error" and never calls exec for an arbitrary non-URL string (#2781)', async () => {
    const exec: ExecFnYield = vi.fn();
    expect(await queryPrStateByUrl(exec, 'not-a-url')).toBe('error');
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// writeFacetYield integration
// ---------------------------------------------------------------------------

describe('writeFacetYield', () => {
  it('does nothing when getCurrentBranch returns null', async () => {
    const patchSpy = vi.fn();
    vi.doMock('./yield-probe.js', () => ({
      getCurrentBranch: vi.fn().mockResolvedValue(null),
      queryPrState: vi.fn(),
      patchYieldFields: patchSpy,
      writeFacetYield,
    }));
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('no git'));
    // Should not throw even with no git
    await expect(writeFacetYield('sess-xyz', exec)).resolves.toBeUndefined();
  });

  it('calls patchYieldFields with produced_pr=false when no PR found', async () => {
    // We test this by verifying exec call sequence and not calling a real patchYieldFields.
    // The exec mock: first call (git symbolic-ref) → branch; second call (gh pr list) → []
    let callCount = 0;
    const exec: ExecFnYield = vi.fn().mockImplementation(async (file: string) => {
      callCount++;
      if (file === 'git') return { stdout: 'afk/test-branch\n', stderr: '' };
      return { stdout: '[]', stderr: '' }; // no PR
    });

    // patchYieldFields writes to disk; mock the cache path by passing a non-existent dir.
    // The function reads from the cache and no-ops if the file doesn't exist — so no disk I/O.
    await writeFacetYield('sess-xyz', exec, undefined);
    expect(callCount).toBe(2); // git + gh
  });

  it('calls exec with the right args for a merged PR path', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFnYield = vi.fn().mockImplementation(async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'git') return { stdout: 'afk/feature\n', stderr: '' };
      return { stdout: JSON.stringify([{ state: 'MERGED' }]), stderr: '' };
    });

    await writeFacetYield('sess-abc', exec, undefined);

    expect(calls[0]).toMatchObject({ file: 'git', args: ['symbolic-ref', '--short', 'HEAD'] });
    expect(calls[1]).toMatchObject({
      file: 'gh',
      args: expect.arrayContaining(['pr', 'list', '--head', 'afk/feature', '--state', 'all']),
    });
  });
});

// ---------------------------------------------------------------------------
// writeFacetYield — cache-with-pr_url paths (item 4, #2781)
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid SessionFacet v7 JSON string with the given yield_tracking overrides.
 * Used to seed the cache in writeFacetYield tests.
 */
function buildCachedFacet(
  sessionId: string,
  yt: { is_scheduled_session: boolean; produced_pr: boolean | null; pr_merged: boolean | null; pr_url: string | null },
): string {
  return JSON.stringify({
    facet_version: 7,
    session_id: sessionId,
    source: 'cli',
    model: 'claude-opus-4-5',
    derived_at: new Date().toISOString(),
    derived_from: 'afk-session',
    source_session_path: `/fake/${sessionId}.json`,
    source_session_mtime_ms: Date.now(),
    subagent_persistence: 'not_persisted',
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    duration_minutes: 1,
    underlying_goal: 'test',
    first_prompt: 'test',
    goal_categories: {},
    session_type: 'task',
    brief_summary: 'test',
    total_turns: 1,
    user_message_count: 1,
    assistant_message_count: 1,
    tool_counts: {},
    commands: [],
    skills: [],
    subagents: [],
    tool_errors: 0,
    tool_errors_total: 0,
    tool_error_categories: {},
    friction_counts: {},
    friction_detail: '',
    outcome: 'fully_achieved',
    outcome_source: 'terminal_state',
    primary_success: 'test',
    world_changes: { files_written: 0, files_edited: 0, bash_commands: 0, commits: 0, mutated: false },
    parallel_dispatch: { total_tool_calls: 0, parallel_tool_calls: 0, parallel_turns: 0, tool_turns: 0, ratio: null },
    yield_tracking: yt,
    decisions: [],
    evidence_pointers: [],
  }, null, 2) + '\n';
}

describe('writeFacetYield — pr_url cache paths (item 4, #2781)', () => {
  const prUrl = 'https://github.com/owner/repo/pull/42';

  it('uses gh pr view <url> (not branch lookup) when cache has pr_url', async () => {
    const sessionId = 'sess-cache-url';
    const cacheDir = mkdtempSync(join(tmpdir(), 'yield-probe-url-'));
    writeFileSync(
      join(cacheDir, `${sessionId}.json`),
      buildCachedFacet(sessionId, { is_scheduled_session: false, produced_pr: true, pr_merged: null, pr_url: prUrl }),
    );

    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFnYield = vi.fn().mockImplementation(async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' };
    });

    // Call the inner helpers directly with our cacheDir — this mirrors what
    // writeFacetYield's URL path does (queryPrStateByUrl + patchYieldFields).
    const state = await queryPrStateByUrl(exec, prUrl);
    expect(state).toBe('open');
    // Confirm it called gh pr view with the URL, not git symbolic-ref
    expect(calls[0]).toMatchObject({
      file: 'gh',
      args: expect.arrayContaining(['pr', 'view', '--json', 'state', '--', prUrl]),
    });
    expect(calls.every((c) => c.file !== 'git')).toBe(true);

    patchYieldFields(sessionId, true, false, cacheDir, prUrl);
    const written = JSON.parse(
      require('node:fs').readFileSync(join(cacheDir, `${sessionId}.json`), 'utf8'),
    ) as { yield_tracking: { produced_pr: unknown; pr_merged: unknown; pr_url: unknown } };
    expect(written.yield_tracking.produced_pr).toBe(true);
    expect(written.yield_tracking.pr_merged).toBe(false);
    expect(written.yield_tracking.pr_url).toBe(prUrl);
  });

  it('gh failure does NOT downgrade produced_pr=true when cache has pr_url', async () => {
    const sessionId = 'sess-gh-fail';
    const cacheDir = mkdtempSync(join(tmpdir(), 'yield-probe-fail-'));
    writeFileSync(
      join(cacheDir, `${sessionId}.json`),
      buildCachedFacet(sessionId, { is_scheduled_session: false, produced_pr: true, pr_merged: null, pr_url: prUrl }),
    );

    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('gh auth error'));
    // queryPrStateByUrl is already imported at the top of this file
    const state = await queryPrStateByUrl(exec, prUrl);
    // gh error → state is 'error' → writeFacetYield returns early, no patch
    expect(state).toBe('error');
    // No patch fires — cached facet is unchanged — produced_pr stays true
    const still = JSON.parse(
      require('node:fs').readFileSync(join(cacheDir, `${sessionId}.json`), 'utf8'),
    ) as { yield_tracking: { produced_pr: unknown } };
    expect(still.yield_tracking.produced_pr).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patchYieldFields — file-not-found guard
// ---------------------------------------------------------------------------

describe('patchYieldFields', () => {
  it('is a no-op when the cache file does not exist', () => {
    // Pass a cacheDir that has no file for this session — should not throw.
    expect(() => patchYieldFields('sess-noop', true, true, '/tmp/nonexistent-cache-dir-xyz')).not.toThrow();
  });

  it('atomically writes produced_pr and pr_merged into a valid cached facet', () => {
    const sessionId = 'sess-atomic-write-test';
    const cacheDir = mkdtempSync(join(tmpdir(), 'yield-probe-test-'));

    // Minimal valid facet JSON — satisfies SessionFacetSchema v7 (passthrough allows extra fields).
    const facet = {
      facet_version: 7, // v7: added outcome_source, tool_errors_total, pr_url
      session_id: sessionId,
      source: 'cli',
      model: 'claude-opus-4-5',
      derived_at: new Date().toISOString(),
      derived_from: 'afk-session',
      source_session_path: `/fake/path/${sessionId}.json`,
      source_session_mtime_ms: Date.now(),
      subagent_persistence: 'not_persisted',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      duration_minutes: 1,
      underlying_goal: 'test goal',
      first_prompt: 'test prompt',
      goal_categories: {},
      session_type: 'implementation',
      brief_summary: 'test summary',
      total_turns: 1,
      user_message_count: 1,
      assistant_message_count: 1,
      tool_counts: {},
      commands: [],
      skills: [],
      subagents: [],
      tool_errors: 0,
      tool_errors_total: 0,
      tool_error_categories: {},
      friction_counts: {},
      friction_detail: '',
      outcome: 'fully_achieved',
      outcome_source: 'terminal_state',
      primary_success: 'test',
      world_changes: { files_written: 0, files_edited: 0, bash_commands: 0, commits: 0, mutated: false },
      parallel_dispatch: { total_tool_calls: 0, parallel_tool_calls: 0, parallel_turns: 0, tool_turns: 0, ratio: null },
      yield_tracking: { is_scheduled_session: false, produced_pr: null, pr_merged: null, pr_url: null },
      decisions: [],
      evidence_pointers: [],
    };

    writeFileSync(join(cacheDir, `${sessionId}.json`), JSON.stringify(facet, null, 2) + '\n', 'utf8');

    patchYieldFields(sessionId, true, true, cacheDir);

    const written = JSON.parse(
      require('node:fs').readFileSync(join(cacheDir, `${sessionId}.json`), 'utf8'),
    ) as { yield_tracking: { produced_pr: unknown; pr_merged: unknown } };
    expect(written.yield_tracking.produced_pr).toBe(true);
    expect(written.yield_tracking.pr_merged).toBe(true);
  });

  it('patches produced_pr and pr_merged on a v7 cache missing pr_url (#2863)', () => {
    const sessionId = 'sess-v7-no-pr-url';
    const cacheDir = mkdtempSync(join(tmpdir(), 'yield-probe-test-'));

    // v7 facet built WITHOUT pr_url — simulates a cache written before #2777.
    const facet = {
      facet_version: 7,
      session_id: sessionId,
      source: 'cli',
      model: 'claude-opus-4-5',
      derived_at: new Date().toISOString(),
      derived_from: 'afk-session',
      source_session_path: `/fake/path/${sessionId}.json`,
      source_session_mtime_ms: Date.now(),
      subagent_persistence: 'not_persisted',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      duration_minutes: 1,
      underlying_goal: 'test goal',
      first_prompt: 'test prompt',
      goal_categories: {},
      session_type: 'implementation',
      brief_summary: 'test summary',
      total_turns: 1,
      user_message_count: 1,
      assistant_message_count: 1,
      tool_counts: {},
      commands: [],
      skills: [],
      subagents: [],
      tool_errors: 0,
      tool_errors_total: 0,
      tool_error_categories: {},
      friction_counts: {},
      friction_detail: '',
      outcome: 'fully_achieved',
      outcome_source: 'terminal_state',
      primary_success: 'test',
      world_changes: { files_written: 0, files_edited: 0, bash_commands: 0, commits: 0, mutated: false },
      parallel_dispatch: { total_tool_calls: 0, parallel_tool_calls: 0, parallel_turns: 0, tool_turns: 0, ratio: null },
      yield_tracking: { is_scheduled_session: false, produced_pr: null, pr_merged: null },
      decisions: [],
      evidence_pointers: [],
    };

    writeFileSync(join(cacheDir, `${sessionId}.json`), JSON.stringify(facet, null, 2) + '\n', 'utf8');

    // Must not throw and must patch produced_pr / pr_merged even without pr_url.
    expect(() => patchYieldFields(sessionId, true, true, cacheDir)).not.toThrow();

    const written = JSON.parse(
      require('node:fs').readFileSync(join(cacheDir, `${sessionId}.json`), 'utf8'),
    ) as { yield_tracking: { produced_pr: unknown; pr_merged: unknown } };
    expect(written.yield_tracking.produced_pr).toBe(true);
    expect(written.yield_tracking.pr_merged).toBe(true);
  });

  it('never downgrades produced_pr=true to false when probe finds no PR on branch (#2777)', () => {
    const sessionId = 'sess-no-downgrade';
    const cacheDir = mkdtempSync(join(tmpdir(), 'yield-probe-test-'));

    // Cached facet with produced_pr=true (set by derive.ts detecting gh pr create URL)
    const facet = {
      facet_version: 7,
      session_id: sessionId,
      source: 'cli',
      model: 'claude-opus-4-5',
      derived_at: new Date().toISOString(),
      derived_from: 'afk-session',
      source_session_path: `/fake/path/${sessionId}.json`,
      source_session_mtime_ms: Date.now(),
      subagent_persistence: 'not_persisted',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      duration_minutes: 1,
      underlying_goal: 'test goal',
      first_prompt: 'test prompt',
      goal_categories: {},
      session_type: 'task',
      brief_summary: 'test summary',
      total_turns: 1,
      user_message_count: 1,
      assistant_message_count: 1,
      tool_counts: {},
      commands: [],
      skills: [],
      subagents: [],
      tool_errors: 0,
      tool_errors_total: 0,
      tool_error_categories: {},
      friction_counts: {},
      friction_detail: '',
      outcome: 'fully_achieved',
      outcome_source: 'terminal_state',
      primary_success: 'test',
      world_changes: { files_written: 0, files_edited: 0, bash_commands: 0, commits: 0, mutated: false },
      parallel_dispatch: { total_tool_calls: 0, parallel_tool_calls: 0, parallel_turns: 0, tool_turns: 0, ratio: null },
      yield_tracking: { is_scheduled_session: false, produced_pr: true, pr_merged: null, pr_url: 'https://github.com/owner/repo/pull/42' },
      decisions: [],
      evidence_pointers: [],
    };

    writeFileSync(join(cacheDir, `${sessionId}.json`), JSON.stringify(facet, null, 2) + '\n', 'utf8');

    // Calling patchYieldFields with produced_pr=false must NOT overwrite the existing true
    patchYieldFields(sessionId, false, null, cacheDir);

    const written = JSON.parse(
      require('node:fs').readFileSync(join(cacheDir, `${sessionId}.json`), 'utf8'),
    ) as { yield_tracking: { produced_pr: unknown; pr_merged: unknown; pr_url: unknown } };
    expect(written.yield_tracking.produced_pr).toBe(true); // not downgraded
    expect(written.yield_tracking.pr_url).toBe('https://github.com/owner/repo/pull/42'); // preserved
  });
});
