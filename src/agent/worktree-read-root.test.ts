/**
 * Unit tests for resolveWorktreeMainRoot — the git-worktree → main-repo-root
 * resolver that lets forked subagents read main-repo paths from a worktree.
 *
 * All cases inject a fake `execFile` so no real git is invoked.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { resolveWorktreeMainRoot, type ExecFileFn } from './worktree-read-root.js';

/** Build a fake execFile that returns fixed rev-parse stdout. */
function fakeGit(stdout: string): ExecFileFn {
  return vi.fn(async () => ({ stdout, stderr: '' }));
}

/** Build a fake execFile that rejects (git failure / not a repo). */
function failingGit(): ExecFileFn {
  return vi.fn(async () => {
    throw new Error('fatal: not a git repository');
  });
}

describe('resolveWorktreeMainRoot', () => {
  const MAIN = '/repo';
  const WORKTREE = '/repo/.afk-worktrees/wt';

  it('returns the main-repo root for a linked worktree', async () => {
    // rev-parse --git-common-dir --show-toplevel from a linked worktree:
    //   line 1 = <main>/.git (absolute), line 2 = <worktree>
    const exec = fakeGit(`${MAIN}/.git\n${WORKTREE}\n`);
    const root = await resolveWorktreeMainRoot(WORKTREE, exec);
    expect(root).toBe(MAIN);
    expect(exec).toHaveBeenCalledWith('git', [
      '-C',
      WORKTREE,
      'rev-parse',
      '--git-common-dir',
      '--show-toplevel',
    ]);
  });

  it('returns undefined for the main worktree (relative .git, toplevel === cwd)', async () => {
    // From the main worktree git prints a RELATIVE ".git" for --git-common-dir.
    const exec = fakeGit(`.git\n${MAIN}\n`);
    const root = await resolveWorktreeMainRoot(MAIN, exec);
    expect(root).toBeUndefined();
  });

  it('returns undefined for the main worktree (absolute .git, toplevel === cwd)', async () => {
    const exec = fakeGit(`${MAIN}/.git\n${MAIN}\n`);
    const root = await resolveWorktreeMainRoot(MAIN, exec);
    expect(root).toBeUndefined();
  });

  it('returns undefined for a subdir of the main worktree', async () => {
    // A plain subdir: --show-toplevel is the main root, not the cwd, so it
    // equals mainRoot → no distinct worktree to grant.
    const exec = fakeGit(`${MAIN}/.git\n${MAIN}\n`);
    const root = await resolveWorktreeMainRoot(`${MAIN}/src`, exec);
    expect(root).toBeUndefined();
  });

  it('returns the main root for a subdir INSIDE a linked worktree', async () => {
    // toplevel is the worktree root (≠ mainRoot), so we still grant the main.
    const exec = fakeGit(`${MAIN}/.git\n${WORKTREE}\n`);
    const root = await resolveWorktreeMainRoot(`${WORKTREE}/src`, exec);
    expect(root).toBe(MAIN);
  });

  it('resolves a relative --git-common-dir against cwd', async () => {
    // Contrived: relative common-dir but toplevel is a distinct worktree.
    const exec = fakeGit(`../../.git\n${WORKTREE}\n`);
    const root = await resolveWorktreeMainRoot(WORKTREE, exec);
    // path.resolve('/repo/.afk-worktrees/wt', '../../.git') → /repo/.git → /repo
    expect(root).toBe(path.resolve(WORKTREE, '../../.git', '..'));
    expect(root).toBe(MAIN);
  });

  it('handles a worktree located OUTSIDE the main repo tree', async () => {
    const exec = fakeGit(`${MAIN}/.git\n/tmp/external-wt\n`);
    const root = await resolveWorktreeMainRoot('/tmp/external-wt', exec);
    expect(root).toBe(MAIN);
  });

  it('returns undefined when cwd is undefined (and never calls git)', async () => {
    const exec = fakeGit('ignored');
    const root = await resolveWorktreeMainRoot(undefined, exec);
    expect(root).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns undefined when cwd is empty (and never calls git)', async () => {
    const exec = fakeGit('ignored');
    const root = await resolveWorktreeMainRoot('', exec);
    expect(root).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns undefined (never throws) when git fails', async () => {
    const exec = failingGit();
    await expect(resolveWorktreeMainRoot(WORKTREE, exec)).resolves.toBeUndefined();
  });

  it('logs the confinement degradation under AFK_DEBUG when git fails (#441)', async () => {
    // The silent return re-confines a forked child to its worktree with no
    // signal; under AFK_DEBUG=1 the degradation must be observable so an
    // unexpectedly-confined subagent is diagnosable.
    const prev = process.env['AFK_DEBUG'];
    process.env['AFK_DEBUG'] = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const root = await resolveWorktreeMainRoot(WORKTREE, failingGit());
      expect(root).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[worktree-read-root]'),
      );
    } finally {
      logSpy.mockRestore();
      if (prev === undefined) delete process.env['AFK_DEBUG'];
      else process.env['AFK_DEBUG'] = prev;
    }
  });

  it('returns undefined on empty git output', async () => {
    const exec = fakeGit('\n');
    const root = await resolveWorktreeMainRoot(WORKTREE, exec);
    expect(root).toBeUndefined();
  });

  it('returns undefined when only one line is printed', async () => {
    const exec = fakeGit(`${MAIN}/.git\n`);
    const root = await resolveWorktreeMainRoot(WORKTREE, exec);
    expect(root).toBeUndefined();
  });
});
