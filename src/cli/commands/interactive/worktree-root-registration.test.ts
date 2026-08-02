/**
 * The `afk -w` session launcher must register its repo root (#771 review).
 *
 * PR #761 wired `registerWorktreeRoot()` into `createManagedWorktree()` and the
 * PR body called that "the single chokepoint" every managed create funnels
 * through. It was not: this launcher builds an identically-shaped managed tree
 * with its own `git worktree add` and writes the same
 * `.afk-worktree-meta.json` protocol, so the sweep engine WOULD reclaim its
 * trees — but the root never entered the registry, so a daemon that does not
 * sit in this repo never looks. A `-w` session killed with `kill -9` (its own
 * cleanup() never runs) in a repo the user does not revisit (so the REPL
 * boot-prune never fires) leaks exactly as #761 describes.
 *
 * Kept in its own file rather than appended to worktree.test.ts, which is
 * already 1164 lines.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorktree } from './worktree.js';
import { readRegisteredWorktreeRoots } from '../../../agent/worktree-root-registry.js';

type ExecResult = { stdout: string; stderr: string };
type ExecCall = { file: string; args: string[]; opts?: { cwd?: string } };

interface MockExecFile {
  (file: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  calls: ExecCall[];
}

/** Mirrors the harness in worktree.test.ts: every git call succeeds. */
function makeMock(repoRoot: string): MockExecFile {
  const calls: ExecCall[] = [];
  const fn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, opts });
    if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return Promise.resolve({ stdout: `${repoRoot}/.git\n`, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  }) as MockExecFile;
  fn.calls = calls;
  return fn;
}

describe('afk -w launcher — sweep root registration', () => {
  let repoRoot: string;

  beforeEach(() => {
    // realpath so the registry's resolve() cannot differ by a /private symlink.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-wt-reg-')));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('records the repo root so a daemon elsewhere can still sweep this repo', async () => {
    const mock = makeMock(repoRoot);

    await setupWorktree(true, { execFile: mock });

    // The add must have happened under this root...
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall).toBeDefined();
    // ...and the root must now be discoverable by the daemon's sweepRootSet().
    expect(await readRegisteredWorktreeRoots()).toContain(repoRoot);
  });

  it('registers only after a successful add', async () => {
    const failing = ((file: string, args: string[], opts?: { cwd?: string }) => {
      void file; void opts;
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return Promise.resolve({ stdout: `${repoRoot}/.git\n`, stderr: '' });
      }
      if (args.includes('worktree') && args.includes('add')) {
        return Promise.reject(Object.assign(new Error('Command failed'), {
          stderr: 'fatal: could not create work tree dir\n',
          stdout: '',
        }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    }) as MockExecFile;
    failing.calls = [];

    await expect(setupWorktree(true, { execFile: failing })).rejects.toThrow();

    // A create that never happened must not leave a root behind for the sweep.
    expect(await readRegisteredWorktreeRoots()).not.toContain(repoRoot);
  });
});
