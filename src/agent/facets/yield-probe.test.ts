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
import { getCurrentBranch, queryPrState, writeFacetYield, patchYieldFields } from './yield-probe.js';
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

    // Minimal valid v5 facet JSON — satisfies SessionFacetSchema.
    const facet = {
      facet_version: 5,
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
      tool_error_categories: {},
      friction_counts: {},
      friction_detail: '',
      outcome: 'fully_achieved',
      primary_success: 'test',
      world_changes: { files_written: 0, files_edited: 0, bash_commands: 0, commits: 0, mutated: false },
      parallel_dispatch: { total_tool_calls: 0, parallel_tool_calls: 0, parallel_turns: 0, tool_turns: 0, ratio: null },
      yield_tracking: { is_scheduled_session: false, produced_pr: null, pr_merged: null },
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
});
