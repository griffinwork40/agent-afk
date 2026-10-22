import { describe, expect, it, vi } from 'vitest';

import { ContinuationRegistry } from './continuation-registry.js';
import {
  captureWorkspaceCheckpoint, checkWorkspaceDrift, CHECKPOINT_GIT_GLOBAL_ARGS, CHECKPOINT_UNAVAILABLE_REASON, type CheckpointGitExec, type GitOutcome,
} from './continuation-guards.js';

const ok = (stdout: string): GitOutcome => ({ ok: true, stdout });

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
    await captureWorkspaceCheckpoint('/repo', exec);
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [, args] of exec.mock.calls) {
      expect(args.slice(0, CHECKPOINT_GIT_GLOBAL_ARGS.length)).toEqual([...CHECKPOINT_GIT_GLOBAL_ARGS]);
      expect(args).toContain('--no-optional-locks');
      expect(args).toContain('core.fsmonitor=false');
    }
  });

  it('a failed or timed-out git status marks the checkpoint unavailable instead of hashing empty status', async () => {
    const failed = await captureWorkspaceCheckpoint('/repo', fakeGit({ ok: false, timedOut: true }));
    expect(failed.unavailable).toBe(true);
    expect(failed.dirtyFingerprint).toBeUndefined();
    const clean = await captureWorkspaceCheckpoint('/repo', fakeGit(ok('')));
    expect(clean.unavailable).toBeUndefined();
    expect(clean.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a timed-out repo probe fails closed (unavailable), a non-repo answer is git:false', async () => {
    const timedOut = await captureWorkspaceCheckpoint('/x', async () => ({ ok: false, timedOut: true }));
    expect(timedOut).toEqual({ cwd: '/x', git: true, unavailable: true });
    const notRepo = await captureWorkspaceCheckpoint('/x', async () => ({ ok: false, timedOut: false }));
    expect(notRepo).toEqual({ cwd: '/x', git: false });
  });

  it('drift check: a write-capable chain with an unavailable prior or recaptured checkpoint is refused', async () => {
    const chain = writeChain();
    chain.checkpoint = { cwd: '/repo', git: true, unavailable: true };
    expect(await checkWorkspaceDrift(chain, async () => ({ cwd: '/repo', git: true, dirtyFingerprint: 'x' }))).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    chain.checkpoint = { cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' };
    expect(await checkWorkspaceDrift(chain, async () => ({ cwd: '/repo', git: true, unavailable: true }))).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    expect(await checkWorkspaceDrift(chain, async () => { throw new Error('boom'); })).toBe(CHECKPOINT_UNAVAILABLE_REASON);
    expect(await checkWorkspaceDrift(chain, async () => ({ cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' }))).toBeUndefined();
    chain.inputs.writeCapable = false; // read-only chains never compare
    chain.checkpoint = { cwd: '/repo', git: true, unavailable: true };
    expect(await checkWorkspaceDrift(chain)).toBeUndefined();
  });
});
