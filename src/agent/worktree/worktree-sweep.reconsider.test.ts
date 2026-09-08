/**
 * Tests for the worktree sweep reconsideration module.
 *
 * Contract: reconsiderLockedWorktree auto-unlocks when the preservation reason
 * has expired, never unlocks human-intent locks or ignored-local-state, and
 * fails safe on probe errors.
 */

import { describe, it, expect } from 'vitest';
import { reconsiderLockedWorktree } from './worktree-sweep.reconsider.js';
import type { ExecFileFn } from './worktree-sweep.js';

interface Call { file: string; args: string[] }

function makeMock(
  responder: (call: Call) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
): ExecFileFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (file: string, args: string[]) => {
    const call = { file, args };
    calls.push(call);
    return responder(call);
  }) as ExecFileFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const TEARDOWN_LOCK_REASON = 'afk: isolated-worktree preserved (commits-ahead)';
const IGNORED_LOCK_REASON = 'afk: isolated-worktree preserved (ignored-local-state: non-rebuildable ignored files present (e.g. .env) — git status looked clean)';
const HUMAN_LOCK_REASON = 'kept by operator';

describe('reconsiderLockedWorktree — commits-ahead', () => {
  it('unlocks when all commits are pushed (log @{upstream}..HEAD is empty)', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('log') && call.args.includes('@{upstream}..HEAD')) {
        return { stdout: '', stderr: '' }; // empty = all pushed
      }
      if (call.args.includes('unlock')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test',
      meta: { preservedReason: 'commits-ahead', commitsAheadAtPreserve: 2 },
      lockReason: TEARDOWN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(true);
    expect(result.reason).toMatch(/all commits now pushed/);
    expect(mock.calls.some((c) => c.args.includes('unlock'))).toBe(true);
  });

  it('does NOT unlock when commits are still unpushed (log returns output)', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('log') && call.args.includes('@{upstream}..HEAD')) {
        return { stdout: 'abc123 some unpushed commit\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test',
      meta: { preservedReason: 'commits-ahead' },
      lockReason: TEARDOWN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
    expect(result.reason).toMatch(/unpushed/);
    expect(mock.calls.some((c) => c.args.includes('unlock'))).toBe(false);
  });

  it('fails safe when git log probe throws (keeps locked)', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('log')) throw new Error('no upstream configured');
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test',
      meta: { preservedReason: 'commits-ahead' },
      lockReason: TEARDOWN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
    expect(mock.calls.some((c) => c.args.includes('unlock'))).toBe(false);
  });
});

describe('reconsiderLockedWorktree — dirty', () => {
  it('unlocks when the working tree is now clean', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('status') && call.args.includes('--porcelain')) {
        return { stdout: '', stderr: '' }; // empty = clean
      }
      if (call.args.includes('unlock')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-dirty',
      meta: { preservedReason: 'dirty' },
      lockReason: 'afk: isolated-worktree preserved (dirty)',
    });

    expect(result.unlocked).toBe(true);
    expect(result.reason).toMatch(/working tree is now clean/);
    expect(mock.calls.some((c) => c.args.includes('unlock'))).toBe(true);
  });

  it('does NOT unlock when the tree is still dirty', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('status') && call.args.includes('--porcelain')) {
        return { stdout: ' M wip.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-still-dirty',
      meta: { preservedReason: 'dirty' },
      lockReason: 'afk: isolated-worktree preserved (dirty)',
    });

    expect(result.unlocked).toBe(false);
    expect(result.reason).toMatch(/still dirty/);
    expect(mock.calls.some((c) => c.args.includes('unlock'))).toBe(false);
  });
});

describe('reconsiderLockedWorktree — never unlocks human-intent or ignored-state', () => {
  it('NEVER auto-unlocks ignored-local-state (non-rebuildable local state)', async () => {
    const unlockCalls: Call[] = [];
    const mock = makeMock((call) => {
      if (call.args.includes('unlock')) { unlockCalls.push(call); return { stdout: '', stderr: '' }; }
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-ignored',
      meta: { preservedReason: 'ignored-local-state' },
      lockReason: IGNORED_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
    expect(unlockCalls).toHaveLength(0);
  });

  it('NEVER auto-unlocks a tree whose lock was not set by the teardown path', async () => {
    const unlockCalls: Call[] = [];
    const mock = makeMock((call) => {
      if (call.args.includes('unlock')) { unlockCalls.push(call); return { stdout: '', stderr: '' }; }
      return { stdout: '', stderr: '' };
    });

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-human',
      meta: { preservedReason: 'commits-ahead' }, // meta says commits-ahead but lock reason is human
      lockReason: HUMAN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
    expect(result.reason).toMatch(/not set by teardown path/);
    expect(unlockCalls).toHaveLength(0);
  });

  it('NEVER auto-unlocks when lockReason is undefined (unknown origin)', async () => {
    const mock = makeMock(() => ({ stdout: '', stderr: '' }));

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-noreason',
      meta: { preservedReason: 'commits-ahead' },
      lockReason: undefined,
    });

    expect(result.unlocked).toBe(false);
  });

  it('NEVER auto-unlocks when meta is absent', async () => {
    const mock = makeMock(() => ({ stdout: '', stderr: '' }));

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-nometa',
      meta: undefined,
      lockReason: TEARDOWN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
  });

  it('NEVER auto-unlocks when meta has no preservedReason', async () => {
    const mock = makeMock(() => ({ stdout: '', stderr: '' }));

    const result = await reconsiderLockedWorktree({
      execFile: mock,
      repoRoot: '/fake/repo',
      worktreePath: '/fake/repo/.afk-worktrees/test-no-preserved-reason',
      meta: { preservedAt: new Date().toISOString() },
      lockReason: TEARDOWN_LOCK_REASON,
    });

    expect(result.unlocked).toBe(false);
  });
});
