import { describe, expect, it, vi } from 'vitest';

import { ContinuationRegistry } from './continuation-registry.js';
import {
  captureCheckpointWithin, captureWorkspaceCheckpoint, checkWorkspaceDrift,
  CHECKPOINT_CAPTURE_DEADLINE_MS, CHECKPOINT_GIT_GLOBAL_ARGS,
  CHECKPOINT_UNAVAILABLE_REASON, PRIOR_CHECKPOINT_UNAVAILABLE_REASON,
  type CheckpointEnumDrivers, type CheckpointGitExec, type GitOutcome,
} from './continuation-guards.js';

const ok = (stdout: string): GitOutcome => ({ ok: true, stdout });

/** No-op driver enumerator: reports zero configured filter drivers. */
const noDrivers: CheckpointEnumDrivers = async () => ({ ok: true, names: [] });

/** Fake git: answers by subcommand; `status` outcome is configurable. */
function fakeGit(status: GitOutcome): ReturnType<typeof vi.fn<CheckpointGitExec>> {
  return vi.fn<CheckpointGitExec>(async (_cwd, args) => {
    const sub = args.slice(CHECKPOINT_GIT_GLOBAL_ARGS.length);
    if (sub[0] === 'status') return status;
    if (sub.includes('--is-inside-work-tree')) return ok('true\n');
    if (sub.includes('--abbrev-ref')) return ok('main\n');
    return ok('abc123\n');
  });
}

function writeChain() {
  const reg = new ContinuationRegistry();
  return reg.createChain({ owner: 'o', rootSessionId: 's', roundCap: 5, inputs: { writeCapable: true } });
}

describe('continuation workspace checkpoint (D5)', () => {
  it('every checkpoint git call passes --no-optional-locks (no index.lock under a concurrent commit)', async () => {
    const exec = fakeGit(ok(''));
    await captureWorkspaceCheckpoint('/repo', exec, noDrivers);
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [, args] of exec.mock.calls) {
      expect(args.slice(0, CHECKPOINT_GIT_GLOBAL_ARGS.length)).toEqual([...CHECKPOINT_GIT_GLOBAL_ARGS]);
      expect(args).toContain('--no-optional-locks');
      expect(args).toContain('core.fsmonitor=false');
    }
  });

  it('status call receives --ignore-submodules=dirty (H6: submodule repos carry their own drivers)', async () => {
    const exec = fakeGit(ok(''));
    await captureWorkspaceCheckpoint('/repo', exec, noDrivers);
    const statusCall = exec.mock.calls.find(([, args]) => {
      const sub = args.slice(CHECKPOINT_GIT_GLOBAL_ARGS.length);
      return sub[0] === 'status';
    });
    expect(statusCall).toBeDefined();
    expect(statusCall?.[1]).toContain('--ignore-submodules=dirty');
  });

  it('filter-driver enumeration fails closed: failed enumeration yields unavailable checkpoint', async () => {
    const failingEnum: CheckpointEnumDrivers = async () => ({ ok: false, error: 'git config failed' });
    const exec = fakeGit(ok(''));
    const result = await captureWorkspaceCheckpoint('/repo', exec, failingEnum);
    expect(result.unavailable).toBe(true);
    // Status must never be called when enumeration fails.
    const statusCall = exec.mock.calls.find(([, args]) => args.includes('--porcelain=v1'));
    expect(statusCall).toBeUndefined();
  });

  it('filter-driver enumeration: drivers present → guarded env passed to data calls', async () => {
    const withDrivers: CheckpointEnumDrivers = async () => ({ ok: true, names: ['lfs'] });
    const envArgs: Array<Record<string, string | undefined> | undefined> = [];
    const exec = vi.fn<CheckpointGitExec>(async (_cwd, args, env) => {
      const sub = args.slice(CHECKPOINT_GIT_GLOBAL_ARGS.length);
      if (sub.includes('--is-inside-work-tree')) return ok('true\n');
      envArgs.push(env);
      if (sub[0] === 'status') return ok('');
      return ok('main\n');
    });
    await captureWorkspaceCheckpoint('/repo', exec, withDrivers);
    // All data calls (branch, HEAD, status) must carry GIT_CONFIG_COUNT overrides.
    for (const env of envArgs) {
      expect(env?.['GIT_CONFIG_COUNT']).toBeDefined();
    }
  });

  it('a failed or timed-out git status marks the checkpoint unavailable instead of hashing empty status', async () => {
    const failed = await captureWorkspaceCheckpoint('/repo', fakeGit({ ok: false, timedOut: true }), noDrivers);
    expect(failed.unavailable).toBe(true);
    expect(failed.dirtyFingerprint).toBeUndefined();
    const clean = await captureWorkspaceCheckpoint('/repo', fakeGit(ok('')), noDrivers);
    expect(clean.unavailable).toBeUndefined();
    expect(clean.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a timed-out repo probe fails closed (unavailable), a non-repo answer is git:false', async () => {
    const timedOut = await captureWorkspaceCheckpoint('/x', async () => ({ ok: false, timedOut: true }), noDrivers);
    expect(timedOut).toEqual({ cwd: '/x', git: true, unavailable: true });
    const notRepo = await captureWorkspaceCheckpoint('/x', async () => ({ ok: false, timedOut: false }), noDrivers);
    expect(notRepo).toEqual({ cwd: '/x', git: false });
  });

  it('drift check: a write-capable chain with an unavailable prior or recaptured checkpoint is refused', async () => {
    const chain = writeChain();
    chain.checkpoint = { cwd: '/repo', git: true, unavailable: true };
    // Prior baseline lost: permanent for the chain, and no recapture is attempted.
    const recapture = vi.fn(async () => ({ cwd: '/repo', git: true, dirtyFingerprint: 'x' }));
    expect(await checkWorkspaceDrift(chain, recapture)).toBe(PRIOR_CHECKPOINT_UNAVAILABLE_REASON);
    expect(recapture).not.toHaveBeenCalled();
    expect(PRIOR_CHECKPOINT_UNAVAILABLE_REASON).toContain('dispatch a new subagent');
    expect(PRIOR_CHECKPOINT_UNAVAILABLE_REASON).not.toContain('retry');
    chain.checkpoint = { cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' };
    expect(await checkWorkspaceDrift(chain, async () => ({ cwd: '/repo', git: true, unavailable: true }))).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    expect(await checkWorkspaceDrift(chain, async () => { throw new Error('boom'); })).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    expect(await checkWorkspaceDrift(chain, async () => ({ cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' }))).toBeUndefined();
    chain.inputs.writeCapable = false; // read-only chains never compare
    chain.checkpoint = { cwd: '/repo', git: true, unavailable: true };
    expect(await checkWorkspaceDrift(chain)).toBeUndefined();
  });

  it('captureCheckpointWithin: a capture that never resolves yields unavailable at the deadline; a rejection too', async () => {
    vi.useFakeTimers();
    try {
      const p = captureCheckpointWithin('/repo', () => new Promise<never>(() => {}));
      await vi.advanceTimersByTimeAsync(CHECKPOINT_CAPTURE_DEADLINE_MS + 1);
      expect(await p).toEqual({ cwd: '/repo', git: true, unavailable: true });
    } finally {
      vi.useRealTimers();
    }
    expect(await captureCheckpointWithin('/repo', async () => { throw new Error('git'); })).toEqual({ cwd: '/repo', git: true, unavailable: true });
    expect(await captureCheckpointWithin('/repo', async () => ({ cwd: '/repo', git: false }))).toEqual({ cwd: '/repo', git: false });
  });

  it('drift check: a recapture that never resolves refuses as unavailable at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const chain = writeChain();
      chain.checkpoint = { cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' };
      const p = checkWorkspaceDrift(chain, () => new Promise<never>(() => {}));
      await vi.advanceTimersByTimeAsync(CHECKPOINT_CAPTURE_DEADLINE_MS + 1);
      expect(await p).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    } finally {
      vi.useRealTimers();
    }
  });
});
