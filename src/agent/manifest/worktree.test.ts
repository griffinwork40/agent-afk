/**
 * Unit tests for worktree detection helpers.
 */

import { describe, it, expect } from 'vitest';
import { isWorktreeCwd, extractWorktreePath, checkWorktreePresence } from './worktree.js';

describe('isWorktreeCwd', () => {
  it('returns true for a path inside .afk-worktrees', () => {
    expect(isWorktreeCwd('/repo/.afk-worktrees/my-branch')).toBe(true);
    expect(isWorktreeCwd('/repo/.afk-worktrees/my-branch/src')).toBe(true);
  });

  it('returns false for a plain project path', () => {
    expect(isWorktreeCwd('/home/user/project/src')).toBe(false);
    expect(isWorktreeCwd('/project')).toBe(false);
  });
});

describe('extractWorktreePath', () => {
  it('extracts root from a nested cwd', () => {
    expect(extractWorktreePath('/repo/.afk-worktrees/my-branch/src'))
      .toBe('/repo/.afk-worktrees/my-branch');
  });

  it('returns the worktree root itself when cwd IS the worktree', () => {
    expect(extractWorktreePath('/repo/.afk-worktrees/my-branch'))
      .toBe('/repo/.afk-worktrees/my-branch');
  });

  it('returns undefined for a non-worktree cwd', () => {
    expect(extractWorktreePath('/project/src')).toBeUndefined();
    expect(extractWorktreePath('/home/user')).toBeUndefined();
  });

  it('handles cwd with multiple nested dirs', () => {
    expect(extractWorktreePath('/deep/repo/.afk-worktrees/branch-name/a/b/c'))
      .toBe('/deep/repo/.afk-worktrees/branch-name');
  });

  it('returns undefined for empty segment after .afk-worktrees/', () => {
    // Edge case: cwd ends with the separator
    expect(extractWorktreePath('/repo/.afk-worktrees/')).toBeUndefined();
  });
});

describe('checkWorktreePresence', () => {
  it('returns ok when worktreePath is undefined', () => {
    expect(checkWorktreePresence(undefined)).toBe('ok');
  });

  it('returns missing when worktreePath does not exist', () => {
    expect(checkWorktreePresence('/tmp/definitely-does-not-exist-12345')).toBe('missing');
  });

  it('returns ok when worktreePath exists', () => {
    // Use /tmp as a guaranteed-to-exist path
    expect(checkWorktreePresence('/tmp')).toBe('ok');
  });
});
