/**
 * Tests for src/cli/git-status-sampler.ts
 *
 * The sampler is fully exercised through its injected `exec` — no real `git`
 * or `gh` process is ever spawned. The injected exec routes by `file`:
 *   - `git symbolic-ref --short HEAD` → the current branch (or throws ⇒ detached)
 *   - `gh pr view --json number --jq .number` → the PR number string (via the
 *     real `resolveCurrentBranchPr`, which calls back into our injected exec)
 */

import { describe, it, expect, vi } from 'vitest';
import { GitStatusSampler, type GitStatusExecFn } from './git-status-sampler.js';

interface MockState {
  /** Branch returned by `git symbolic-ref`; null ⇒ exec throws (detached HEAD). */
  branch: string | null;
  /** PR stdout returned by `gh pr view`; null ⇒ empty (no PR); 'throw' ⇒ exec throws. */
  pr: string | null | 'throw';
  now: number;
}

function makeSampler(initial?: Partial<MockState>, prTtlMs = 60_000) {
  // Use `in` checks (not `??`) so an intentional `null` (detached HEAD / no PR)
  // is honored rather than swallowed by the default.
  const state: MockState = {
    branch: initial && 'branch' in initial ? (initial.branch as string | null) : 'feat/x',
    pr: initial && 'pr' in initial ? (initial.pr as string | null | 'throw') : '123',
    now: initial?.now ?? 1000,
  };
  const calls = { git: 0, gh: 0 };
  const exec: GitStatusExecFn = vi.fn(async (file: string, _args: string[], _cwd: string) => {
    if (file === 'git') {
      calls.git++;
      if (state.branch === null) throw new Error('not a symbolic ref'); // detached HEAD
      return { stdout: state.branch + '\n', stderr: '' };
    }
    // gh pr view
    calls.gh++;
    if (state.pr === 'throw') throw new Error('gh failed');
    return { stdout: (state.pr ?? '') + '\n', stderr: '' };
  });
  const sampler = new GitStatusSampler({ cwd: '/repo', exec, now: () => state.now, prTtlMs });
  return { sampler, state, calls, exec };
}

describe('GitStatusSampler', () => {
  it('resolves the current branch and open PR', async () => {
    const { sampler } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getBranch()).toBe('feat/x');
    expect(sampler.getPr()).toBe(123);
  });

  it('runs git and gh in the configured cwd', async () => {
    const { sampler, exec } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    for (const call of (exec as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(call[2]).toBe('/repo'); // 3rd arg is cwd
    }
  });

  it('leaves branch and PR undefined on a detached HEAD (git symbolic-ref fails)', async () => {
    const { sampler } = makeSampler({ branch: null });
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getBranch()).toBeUndefined();
    expect(sampler.getPr()).toBeUndefined();
  });

  it('skips the PR network call entirely on a detached HEAD', async () => {
    const { sampler, calls } = makeSampler({ branch: null });
    await sampler.refresh({ blockOnPr: true });
    expect(calls.git).toBe(1);
    expect(calls.gh).toBe(0);
  });

  it('shows the branch but no PR when the branch has no open PR', async () => {
    const { sampler } = makeSampler({ pr: null });
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getBranch()).toBe('feat/x');
    expect(sampler.getPr()).toBeUndefined();
  });

  it('never throws and leaves the PR empty when gh fails', async () => {
    const { sampler } = makeSampler({ pr: 'throw' });
    await expect(sampler.refresh({ blockOnPr: true })).resolves.toBeUndefined();
    expect(sampler.getBranch()).toBe('feat/x');
    expect(sampler.getPr()).toBeUndefined();
  });

  it('does not re-query the PR for the same branch within the TTL', async () => {
    const { sampler, state, calls } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    const ghAfterFirst = calls.gh;
    expect(ghAfterFirst).toBe(1);

    state.now += 1_000; // well within the 60s TTL
    await sampler.refresh({ blockOnPr: true });
    expect(calls.gh).toBe(ghAfterFirst); // no re-fetch
  });

  it('re-queries the PR for the same branch once the TTL elapses', async () => {
    const { sampler, state, calls } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    expect(calls.gh).toBe(1);

    state.now += 60_000; // TTL boundary reached
    await sampler.refresh({ blockOnPr: true });
    expect(calls.gh).toBe(2);
  });

  it('re-fetches the PR immediately when the branch changes', async () => {
    const { sampler, state, calls } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getPr()).toBe(123);

    state.branch = 'feat/y';
    state.pr = '456';
    state.now += 1_000; // still within TTL — branch change must override it
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getBranch()).toBe('feat/y');
    expect(sampler.getPr()).toBe(456);
    expect(calls.gh).toBe(2);
  });

  it('dedupes concurrent branch refreshes', async () => {
    const { sampler, calls } = makeSampler();
    await Promise.all([sampler.refresh(), sampler.refresh(), sampler.refresh()]);
    expect(calls.git).toBe(1);
  });

  it('reset() clears the cached branch and PR', async () => {
    const { sampler } = makeSampler();
    await sampler.refresh({ blockOnPr: true });
    expect(sampler.getBranch()).toBe('feat/x');
    sampler.reset();
    expect(sampler.getBranch()).toBeUndefined();
    expect(sampler.getPr()).toBeUndefined();
  });

  it('dispose() stops further sampling', async () => {
    const { sampler, calls } = makeSampler();
    sampler.dispose();
    await sampler.refresh({ blockOnPr: true });
    expect(calls.git).toBe(0);
    expect(sampler.getBranch()).toBeUndefined();
  });

  it('fires onUpdate when the branch first resolves and again when the PR lands', async () => {
    const onUpdate = vi.fn();
    const { sampler } = makeSampler();
    sampler.setOnUpdate(onUpdate);
    await sampler.refresh({ blockOnPr: true });
    // One notify for branch (undefined → feat/x), one for PR (undefined → 123).
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not fire onUpdate on a no-op refresh (same branch, same PR, within TTL)', async () => {
    const onUpdate = vi.fn();
    const { sampler, state } = makeSampler();
    sampler.setOnUpdate(onUpdate);
    await sampler.refresh({ blockOnPr: true });
    onUpdate.mockClear();
    state.now += 1_000; // within TTL — no re-fetch, nothing changes
    await sampler.refresh({ blockOnPr: true });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('fires onUpdate once when the branch changes (PR cleared then re-resolved)', async () => {
    const onUpdate = vi.fn();
    const { sampler, state } = makeSampler();
    sampler.setOnUpdate(onUpdate);
    await sampler.refresh({ blockOnPr: true });
    onUpdate.mockClear();
    state.branch = 'feat/y';
    state.pr = '456';
    await sampler.refresh({ blockOnPr: true });
    // One notify for the branch change (clears stale PR), one for the new PR.
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(sampler.getBranch()).toBe('feat/y');
    expect(sampler.getPr()).toBe(456);
  });

  it('swallows a throwing onUpdate callback without breaking sampling', async () => {
    const { sampler } = makeSampler();
    sampler.setOnUpdate(() => {
      throw new Error('repaint blew up');
    });
    await expect(sampler.refresh({ blockOnPr: true })).resolves.toBeUndefined();
    expect(sampler.getBranch()).toBe('feat/x');
    expect(sampler.getPr()).toBe(123);
  });

  it('discards a stale PR result when the branch changed during the in-flight fetch', async () => {
    // gh hangs until we resolve it manually, simulating a slow network call.
    let resolveGh: (v: { stdout: string; stderr: string }) => void = () => {};
    const ghPromise = new Promise<{ stdout: string; stderr: string }>((r) => {
      resolveGh = r;
    });
    const state = { branch: 'A' };
    const exec: GitStatusExecFn = async (file) => {
      if (file === 'git') return { stdout: state.branch + '\n', stderr: '' };
      return ghPromise; // gh always returns ghPromise (re-used for the follow-up)
    };
    const sampler = new GitStatusSampler({ cwd: '/r', exec, now: () => 1000 });

    await sampler.refresh(); // branch=A; PR(A) fetch in flight
    expect(sampler.getBranch()).toBe('A');

    state.branch = 'B';
    await sampler.refresh(); // branch=B; PR(A) still in flight
    expect(sampler.getBranch()).toBe('B');
    expect(sampler.getPr()).toBeUndefined(); // B's PR not resolved yet

    // Resolve the in-flight gh(A) lookup. A's result is discarded by the branch
    // guard, then a follow-up fetch for B is kicked automatically. Because
    // ghPromise is already resolved, B's fetch settles in the next microtask.
    resolveGh({ stdout: '111\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 10)); // allow all microtasks to settle
    // B's PR is now resolved via the follow-up kick — NOT from A's stale result.
    expect(sampler.getPr()).toBe(111);
    expect(sampler.getBranch()).toBe('B'); // branch was never corrupted
  });

  it('fetches PR for branch B after an in-flight fetch for branch A settles', async () => {
    // Verify C1: the .finally() follow-up kick resolves the new branch's PR
    // when B's gh call returns a *different* result from A's.
    let resolveGhA: (v: { stdout: string; stderr: string }) => void = () => {};
    const ghAPromise = new Promise<{ stdout: string; stderr: string }>((r) => {
      resolveGhA = r;
    });
    const state = { branch: 'A', ghResult: '111' };
    const exec: GitStatusExecFn = async (file) => {
      if (file === 'git') return { stdout: state.branch + '\n', stderr: '' };
      if (state.branch === 'A') return ghAPromise; // A hangs
      return { stdout: state.ghResult + '\n', stderr: '' }; // B resolves immediately
    };
    const sampler = new GitStatusSampler({ cwd: '/r', exec, now: () => 1000 });

    await sampler.refresh(); // branch=A; PR(A) fetch in flight
    expect(sampler.getBranch()).toBe('A');

    state.branch = 'B';
    state.ghResult = '456';
    await sampler.refresh(); // branch=B; PR(A) still in flight
    expect(sampler.getBranch()).toBe('B');
    expect(sampler.getPr()).toBeUndefined(); // B's PR not yet resolved

    // A's stale result settles → discarded → follow-up for B kicks and resolves.
    resolveGhA({ stdout: '111\n', stderr: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sampler.getPr()).toBe(456); // B's PR, not A's
  });

  it('reset() mid-fetch discards the settling result without writing stale state', async () => {
    // Verify C2: in-flight updateBranch captures a generation token and returns
    // early if reset() has incremented it before the git call settles.
    let resolveBranch: (v: { stdout: string; stderr: string }) => void = () => {};
    const branchPromise = new Promise<{ stdout: string; stderr: string }>((r) => {
      resolveBranch = r;
    });
    const exec: GitStatusExecFn = async (file) => {
      if (file === 'git') return branchPromise; // branch fetch hangs
      return { stdout: '123\n', stderr: '' };
    };
    const sampler = new GitStatusSampler({ cwd: '/r', exec, now: () => 1000 });

    const refreshPromise = sampler.refresh(); // branch fetch in flight
    sampler.reset(); // advance the generation token mid-flight

    resolveBranch({ stdout: 'feat/x\n', stderr: '' }); // settle the stale fetch
    await refreshPromise;

    // The stale result must have been discarded — branch stays cleared.
    expect(sampler.getBranch()).toBeUndefined();
    expect(sampler.getPr()).toBeUndefined();
  });
});
