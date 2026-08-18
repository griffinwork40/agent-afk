import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./worktree-managed.js', async (importActual) => {
  const actual = await importActual<typeof import('./worktree-managed.js')>();
  return { ...actual, teardownIsolatedWorktree: vi.fn() };
});

import { execFile } from 'node:child_process';
import { teardownIsolatedWorktree } from './worktree-managed.js';
import {
  lockWorktreeForBackground,
  teardownBackgroundWorktree,
  unlockWorktreeForPromotion,
} from './worktree-managed.background.js';

const mockExecFile = vi.mocked(execFile);
const mockTeardown = vi.mocked(teardownIsolatedWorktree);
const repoRoot = '/repo';
const worktreePath = '/repo/.afk-worktrees/job';

function execSucceeds(): void {
  mockExecFile.mockImplementation((_file, _args, callback) => {
    if (typeof callback === 'function') callback(null, '', '');
    return undefined as unknown as ReturnType<typeof execFile>;
  });
}

function execFails(error = new Error('git failed')): void {
  mockExecFile.mockImplementation((_file, _args, callback) => {
    if (typeof callback === 'function') callback(error, '', '');
    return undefined as unknown as ReturnType<typeof execFile>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  execSucceeds();
  mockTeardown.mockResolvedValue({ removed: true, preserved: false });
});

describe('lockWorktreeForBackground', () => {
  it('calls git worktree lock with the correct arguments', async () => {
    await lockWorktreeForBackground(repoRoot, worktreePath);

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      [
        '-C', repoRoot, 'worktree', 'lock',
        '--reason', 'afk: background-isolated-worktree in use by detached child',
        worktreePath,
      ],
      expect.any(Function),
    );
  });

  it('swallows exec failure', async () => {
    execFails();

    await expect(lockWorktreeForBackground(repoRoot, worktreePath)).resolves.toBeUndefined();
  });
});

describe('unlockWorktreeForPromotion', () => {
  it('calls git worktree unlock with the correct arguments', async () => {
    await unlockWorktreeForPromotion(repoRoot, worktreePath);

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', repoRoot, 'worktree', 'unlock', worktreePath],
      expect.any(Function),
    );
  });

  it('propagates errors', async () => {
    const error = new Error('unlock failed');
    execFails(error);

    await expect(unlockWorktreeForPromotion(repoRoot, worktreePath)).rejects.toBe(error);
  });
});

describe('teardownBackgroundWorktree', () => {
  it('unlocks before calling teardownIsolatedWorktree', async () => {
    const order: string[] = [];
    mockExecFile.mockImplementation((_file, _args, callback) => {
      order.push('unlock');
      if (typeof callback === 'function') callback(null, '', '');
      return undefined as unknown as ReturnType<typeof execFile>;
    });
    mockTeardown.mockImplementation(async () => {
      order.push('teardown');
      return { removed: true, preserved: false };
    });

    await expect(teardownBackgroundWorktree({ repoRoot, worktreePath }))
      .resolves.toEqual({ removed: true, preserved: false });

    expect(order).toEqual(['unlock', 'teardown']);
    expect(mockTeardown).toHaveBeenCalledWith({ repoRoot, worktreePath });
  });

  it('continues to teardown when unlock fails', async () => {
    execFails(new Error('already unlocked'));

    await expect(teardownBackgroundWorktree({ repoRoot, worktreePath }))
      .resolves.toEqual({ removed: true, preserved: false });
    expect(mockTeardown).toHaveBeenCalledWith({ repoRoot, worktreePath });
  });
});
