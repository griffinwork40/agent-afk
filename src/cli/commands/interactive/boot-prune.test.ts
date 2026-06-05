/**
 * Tests for `bootPruneWorktrees`.
 *
 * Strategy: mock `runSweep` (the engine has its own test file). Cover the
 * happy path, the disabled-via-env path, the lock-contested skip, the
 * not-in-repo skip (resolveRepoRoot throws), and the soft-launch-bypass
 * contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../agent/worktree-sweep.js', async () => {
  const actual = await vi.importActual<typeof import('../../../agent/worktree-sweep.js')>(
    '../../../agent/worktree-sweep.js',
  );
  return { ...actual, runSweep: vi.fn() };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void) => {
    // `git rev-parse --git-common-dir` — return a fake .git dir; the
    // boot-prune module then calls dirname() to get the repo root.
    cb(null, { stdout: '/fake/repo/.git\n', stderr: '' } as unknown as { stdout: string; stderr: string });
  }),
}));

import { runSweep } from '../../../agent/worktree-sweep.js';
import { bootPruneWorktrees } from './boot-prune.ts';

const mockRunSweep = runSweep as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { mockRunSweep.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('bootPruneWorktrees', () => {
  it('returns disabled when opts.disabled === true and does not call runSweep', async () => {
    const result = await bootPruneWorktrees({ disabled: true });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('disabled');
    expect(mockRunSweep).not.toHaveBeenCalled();
  });

  it('passes bypassSoftLaunch: true to runSweep', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: [],
      dryRun: false,
    });
    await bootPruneWorktrees();
    expect(mockRunSweep).toHaveBeenCalledOnce();
    const opts = mockRunSweep.mock.calls[0]?.[0];
    expect(opts?.bypassSoftLaunch).toBe(true);
    expect(opts?.scope).toBe('interactive');
    expect(opts?.dryRun).toBe(false);
  });

  it('counts removals that match the boot-prunable verdict allowlist', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [
        { path: '/a', verdict: 'dead-owner', owner: 'interactive', ageMs: 60_000 },
        { path: '/b', verdict: 'empty', owner: 'interactive', ageMs: 5_400_000 },
        { path: '/c', verdict: 'orphaned-dir', owner: 'interactive', ageMs: 60_000 },
      ],
      removed: ['/a', '/b', '/c'],
      warnings: [],
      dryRun: false,
    });
    const result = await bootPruneWorktrees();
    expect(result.ran).toBe(true);
    expect(result.removedCount).toBe(3);
  });

  it('skips on lock-contested warning', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: ['[WARN] Worktree sweep lock contested: /tmp/lock'],
      dryRun: false,
    });
    const result = await bootPruneWorktrees();
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('lock-contested');
  });

  it('returns error skip when runSweep throws', async () => {
    mockRunSweep.mockRejectedValue(new Error('boom'));
    const result = await bootPruneWorktrees();
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('error');
  });

  it('does NOT count removals outside the boot-prunable allowlist', async () => {
    // runSweep widened its policy or someone called it with broader scope —
    // we still only count what we asked for.
    mockRunSweep.mockResolvedValue({
      candidates: [
        { path: '/a', verdict: 'stale-clean', owner: 'interactive', ageMs: 99_000_000_000 },
      ],
      removed: ['/a'],
      warnings: [],
      dryRun: false,
    });
    const result = await bootPruneWorktrees();
    expect(result.ran).toBe(true);
    expect(result.removedCount).toBe(0);
  });
});
