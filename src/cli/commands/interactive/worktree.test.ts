/**
 * Tests for `setupWorktree` — the worktree helper used by `afk interactive`.
 *
 * Strategy: dependency-injected `execFile` mock for git invocations; real
 * `node:fs` against a tmpdir for the `.gitignore` mutation contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorktree, setupWorktreeDeferred } from './worktree.js';

type ExecResult = { stdout: string; stderr: string };
type ExecCall = { file: string; args: string[]; opts?: { cwd?: string } };
type ExecHandler = (call: ExecCall) => Promise<ExecResult>;

interface MockExecFile {
  (file: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  calls: ExecCall[];
}

function makeMock(handler: ExecHandler): MockExecFile {
  const calls: ExecCall[] = [];
  const fn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, opts });
    return handler({ file, args, opts });
  }) as MockExecFile;
  fn.calls = calls;
  return fn;
}

/** Default handler — succeeds on every git call with empty output. */
function defaultHandler(repoRoot: string): ExecHandler {
  return async ({ args }) => {
    if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
      return { stdout: `${repoRoot}/.git\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('setupWorktree', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-worktree-test-')));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('throws when not inside a git repository', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        const err = Object.assign(new Error('Command failed'), {
          stderr: 'fatal: not a git repository\n',
          stdout: '',
        });
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await expect(setupWorktree(true, { execFile: mock })).rejects.toThrow(
      /Not in a git repository/,
    );
  });

  it('auto-generates a branch name matching afk/YYYYMMDD-HHMMSS-hex6', async () => {
    const mock = makeMock(defaultHandler(repoRoot));

    const handle = await setupWorktree(true, { execFile: mock });
    expect(handle.branch).toMatch(/^afk\/\d{8}-\d{6}-[0-9a-f]{6}$/);

    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall).toBeDefined();
    const branchArg = addCall!.args[addCall!.args.indexOf('-b') + 1];
    expect(branchArg).toMatch(/^afk\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it('passes through an explicit branch name', async () => {
    const mock = makeMock(defaultHandler(repoRoot));

    const handle = await setupWorktree('feat-x', { execFile: mock });
    expect(handle.branch).toBe('feat-x');

    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall).toBeDefined();
    expect(addCall!.args).toContain('-b');
    expect(addCall!.args[addCall!.args.indexOf('-b') + 1]).toBe('feat-x');
    const pathArg = addCall!.args[addCall!.args.length - 1];
    expect(pathArg!.endsWith('/.afk-worktrees/feat-x')).toBe(true);
    expect(handle.path.endsWith('/.afk-worktrees/feat-x')).toBe(true);
  });

  it('slugifies a branch name with a slash for the directory but keeps branch name unchanged', async () => {
    const mock = makeMock(defaultHandler(repoRoot));

    const handle = await setupWorktree('feat/x', { execFile: mock });
    expect(handle.branch).toBe('feat/x');

    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall).toBeDefined();
    expect(addCall!.args[addCall!.args.indexOf('-b') + 1]).toBe('feat/x');
    const pathArg = addCall!.args[addCall!.args.length - 1];
    expect(pathArg!.endsWith('/.afk-worktrees/feat-x')).toBe(true);
    expect(handle.path.endsWith('/.afk-worktrees/feat-x')).toBe(true);
  });

  it('creates .gitignore with .afk-worktrees/ entry and is idempotent', async () => {
    const mock = makeMock(defaultHandler(repoRoot));
    const gitignorePath = join(repoRoot, '.gitignore');

    await setupWorktree('first', { execFile: mock });
    const after1 = await fs.readFile(gitignorePath, 'utf8');
    expect(after1.split('\n').filter((l) => l.trim() === '.afk-worktrees/')).toHaveLength(1);

    await setupWorktree('second', { execFile: mock });
    const after2 = await fs.readFile(gitignorePath, 'utf8');
    expect(after2).toBe(after1);
    expect(after2.split('\n').filter((l) => l.trim() === '.afk-worktrees/')).toHaveLength(1);
  });

  it('rethrows a clear error when the branch is already checked out elsewhere', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('add')) {
        const err = Object.assign(new Error("fatal: 'feat-x' is already checked out at '/somewhere'"), {
          stderr: "fatal: 'feat-x' is already checked out at '/somewhere'\n",
          stdout: '',
        });
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await expect(setupWorktree('feat-x', { execFile: mock })).rejects.toThrow(
      /feat-x.*already checked out/,
    );
  });

  it('cleanup with a clean tree removes the worktree and deletes the branch', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      // status --porcelain → empty (clean)
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const callsBefore = mock.calls.length;
    await handle.cleanup();
    const cleanupCalls = mock.calls.slice(callsBefore);

    const statusCall = cleanupCalls.find(
      (c) => c.args.includes('status') && c.args.includes('--porcelain'),
    );
    const removeCall = cleanupCalls.find(
      (c) => c.args.includes('worktree') && c.args.includes('remove'),
    );
    const branchDeleteCall = cleanupCalls.find(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(statusCall).toBeDefined();
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toContain('--force');
    expect(branchDeleteCall).toBeDefined();
    expect(branchDeleteCall!.args[branchDeleteCall!.args.indexOf('-d') + 1]).toBe('feat-x');

    // Order: status → remove → branch -d
    const statusIdx = cleanupCalls.indexOf(statusCall!);
    const removeIdx = cleanupCalls.indexOf(removeCall!);
    const branchIdx = cleanupCalls.indexOf(branchDeleteCall!);
    expect(statusIdx).toBeLessThan(removeIdx);
    expect(removeIdx).toBeLessThan(branchIdx);
  });

  it('cleanup with a dirty tree preserves the worktree and logs', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: ' M file.txt\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const callsBefore = mock.calls.length;
    await handle.cleanup();
    const cleanupCalls = mock.calls.slice(callsBefore);

    expect(
      cleanupCalls.some((c) => c.args.includes('worktree') && c.args.includes('remove')),
    ).toBe(false);
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/preserved/);
    expect(logged).toContain(handle.path);
  });

  describe('cd-on-exit marker (preserved worktree → shell wrapper handoff)', () => {
    // Isolate the marker file under a per-test AFK_HOME so we never touch
    // the user's real ~/.afk/state/. The cd-on-exit module reads AFK_HOME
    // every call (no caching), so setting it in beforeEach is sufficient.
    let prevAfkHome: string | undefined;
    let prevWrapper: string | undefined;
    let afkHomeTmp: string;

    beforeEach(() => {
      prevAfkHome = process.env['AFK_HOME'];
      prevWrapper = process.env['AFK_SHELL_WRAPPER'];
      afkHomeTmp = realpathSync(mkdtempSync(join(tmpdir(), 'afk-cd-intent-wt-')));
      process.env['AFK_HOME'] = afkHomeTmp;
      delete process.env['AFK_SHELL_WRAPPER'];
    });

    afterEach(() => {
      if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
      else process.env['AFK_HOME'] = prevAfkHome;
      if (prevWrapper === undefined) delete process.env['AFK_SHELL_WRAPPER'];
      else process.env['AFK_SHELL_WRAPPER'] = prevWrapper;
      try {
        rmSync(afkHomeTmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('writes $AFK_HOME/state/last-cwd with the preserved worktree path on dirty cleanup', async () => {
      const mock = makeMock(async ({ args }) => {
        if (args.includes('rev-parse')) {
          return { stdout: `${repoRoot}/.git\n`, stderr: '' };
        }
        if (args.includes('status') && args.includes('--porcelain')) {
          return { stdout: ' M file.txt\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      const handle = await setupWorktree('feat-cd', { execFile: mock });
      await handle.cleanup();

      const marker = join(afkHomeTmp, 'state', 'last-cwd');
      expect(await fs.readFile(marker, 'utf8')).toBe(handle.path);
    });

    it('writes NO marker on a clean cleanup (worktree is removed; nothing to cd to)', async () => {
      const mock = makeMock(async ({ args }) => {
        if (args.includes('rev-parse')) {
          return { stdout: `${repoRoot}/.git\n`, stderr: '' };
        }
        // clean: empty status → fall through to remove
        if (args.includes('status') && args.includes('--porcelain')) {
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const handle = await setupWorktree('feat-clean', { execFile: mock });
      await handle.cleanup();

      const marker = join(afkHomeTmp, 'state', 'last-cwd');
      await expect(fs.readFile(marker, 'utf8')).rejects.toThrow(/ENOENT/);
    });

    it('prints the install hint on dirty cleanup when AFK_SHELL_WRAPPER is NOT set', async () => {
      const mock = makeMock(async ({ args }) => {
        if (args.includes('rev-parse')) {
          return { stdout: `${repoRoot}/.git\n`, stderr: '' };
        }
        if (args.includes('status') && args.includes('--porcelain')) {
          return { stdout: ' M file.txt\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const handle = await setupWorktree('feat-hint', { execFile: mock });
      await handle.cleanup();

      const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain(`cd ${handle.path}`);
      expect(logged).toContain('afk shell-init');
    });

    it('emits the bash/zsh install hint when $SHELL is zsh', async () => {
      const prevShell = process.env['SHELL'];
      process.env['SHELL'] = '/bin/zsh';
      try {
        const mock = makeMock(async ({ args }) => {
          if (args.includes('rev-parse')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
          if (args.includes('status') && args.includes('--porcelain'))
            return { stdout: ' M f\n', stderr: '' };
          return { stdout: '', stderr: '' };
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const handle = await setupWorktree('feat-zsh', { execFile: mock });
        await handle.cleanup();
        const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logged).toContain('eval "$(afk shell-init)"');
        expect(logged).not.toContain('| source');
      } finally {
        if (prevShell === undefined) delete process.env['SHELL'];
        else process.env['SHELL'] = prevShell;
      }
    });

    it('emits the fish install hint when $SHELL is fish (regression: was bash-only)', async () => {
      const prevShell = process.env['SHELL'];
      process.env['SHELL'] = '/usr/local/bin/fish';
      try {
        const mock = makeMock(async ({ args }) => {
          if (args.includes('rev-parse')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
          if (args.includes('status') && args.includes('--porcelain'))
            return { stdout: ' M f\n', stderr: '' };
          return { stdout: '', stderr: '' };
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const handle = await setupWorktree('feat-fish', { execFile: mock });
        await handle.cleanup();
        const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logged).toContain('afk shell-init fish | source');
        // bash-form must NOT appear when the user is on fish.
        expect(logged).not.toContain('eval "$(afk shell-init)"');
      } finally {
        if (prevShell === undefined) delete process.env['SHELL'];
        else process.env['SHELL'] = prevShell;
      }
    });

    it('suppresses the install hint when AFK_SHELL_WRAPPER=1 (wrapper already active)', async () => {
      process.env['AFK_SHELL_WRAPPER'] = '1';

      const mock = makeMock(async ({ args }) => {
        if (args.includes('rev-parse')) {
          return { stdout: `${repoRoot}/.git\n`, stderr: '' };
        }
        if (args.includes('status') && args.includes('--porcelain')) {
          return { stdout: ' M file.txt\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const handle = await setupWorktree('feat-quiet', { execFile: mock });
      await handle.cleanup();

      const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      // Preserved line still appears, but the install hint is suppressed.
      expect(logged).toMatch(/preserved/);
      expect(logged).not.toContain('afk shell-init');
      // Marker is still written — that's what the wrapper reads.
      const marker = join(afkHomeTmp, 'state', 'last-cwd');
      expect(await fs.readFile(marker, 'utf8')).toBe(handle.path);
    });
  });

  describe('branch name validation', () => {
    it("rejects a branch name starting with '-' (would be parsed by git as a flag)", async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree('-D', { execFile: mock })).rejects.toThrow(
        /Invalid branch name/,
      );
      // No `git worktree add` should have run.
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
    });

    it("rejects a branch name containing '..'", async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree('feat..x', { execFile: mock })).rejects.toThrow(
        /Invalid branch name/,
      );
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
    });

    it("rejects 'HEAD' as a reserved branch name", async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree('HEAD', { execFile: mock })).rejects.toThrow(
        /Invalid branch name/,
      );
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
    });

    it('rejects a branch name containing whitespace', async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree('feat with space', { execFile: mock })).rejects.toThrow(
        /Invalid branch name/,
      );
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
    });

    it('rejects an empty branch name', async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree('', { execFile: mock })).rejects.toThrow(
        /Invalid branch name/,
      );
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
    });

    it('auto-named branches pass validation', async () => {
      const mock = makeMock(defaultHandler(repoRoot));
      await expect(setupWorktree(true, { execFile: mock })).resolves.toBeDefined();
      expect(mock.calls.some((c) => c.args.includes('add'))).toBe(true);
    });
  });

  it('cleanup swallows a `branch -d` failure but warns', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('branch') && args.includes('-d')) {
        const err = Object.assign(new Error('error: branch is not fully merged'), {
          stderr: "error: the branch 'feat-x' is not fully merged.\n",
          stdout: '',
        });
        throw err;
      }
      // worktree remove succeeds
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handle.cleanup()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/feat-x/);
  });

  it('cleanup swallows a `git status --porcelain` failure and warns (worktree dir gone)', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        const err = Object.assign(
          new Error("fatal: not a git repository: '/missing/worktree/.git'"),
          {
            stderr: "fatal: not a git repository: '/missing/worktree/.git'\n",
            stdout: '',
          },
        );
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const callsBefore = mock.calls.length;
    await expect(handle.cleanup()).resolves.toBeUndefined();
    const cleanupCalls = mock.calls.slice(callsBefore);

    // Status was attempted, but neither `worktree remove` nor `branch -d` ran.
    expect(
      cleanupCalls.some((c) => c.args.includes('status') && c.args.includes('--porcelain')),
    ).toBe(true);
    expect(
      cleanupCalls.some((c) => c.args.includes('worktree') && c.args.includes('remove')),
    ).toBe(false);
    expect(cleanupCalls.some((c) => c.args.includes('branch') && c.args.includes('-d'))).toBe(
      false,
    );

    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/cleanup/i);
    expect(warned).toContain(handle.path);
  });

  it('cleanup swallows a `worktree remove --force` failure and warns', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('worktree') && args.includes('remove')) {
        const err = Object.assign(
          new Error("fatal: cannot remove worktree: locked"),
          {
            stderr: "fatal: cannot remove worktree: locked\n",
            stdout: '',
          },
        );
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const callsBefore = mock.calls.length;
    await expect(handle.cleanup()).resolves.toBeUndefined();
    const cleanupCalls = mock.calls.slice(callsBefore);

    // Remove was attempted; branch -d should NOT be attempted after remove fails.
    expect(
      cleanupCalls.some((c) => c.args.includes('worktree') && c.args.includes('remove')),
    ).toBe(true);
    expect(cleanupCalls.some((c) => c.args.includes('branch') && c.args.includes('-d'))).toBe(
      false,
    );

    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/worktree remove/i);
    expect(warned).toContain(handle.path);
  });

  it('cleanup with force:true skips status check and removes unconditionally', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        // This should never be called in the force path
        throw new Error('status check should not be called in force path');
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const callsBefore = mock.calls.length;

    await expect(handle.cleanup({ force: true })).resolves.toBeUndefined();
    const cleanupCalls = mock.calls.slice(callsBefore);

    // No status check was made
    expect(
      cleanupCalls.some((c) => c.args.includes('status') && c.args.includes('--porcelain')),
    ).toBe(false);

    // worktree remove --force was called
    const removeCall = cleanupCalls.find(
      (c) => c.args.includes('worktree') && c.args.includes('remove'),
    );
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toContain('--force');

    // branch -d was called
    const branchDeleteCall = cleanupCalls.find(
      (c) => c.args.includes('branch') && c.args.includes('-d'),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(branchDeleteCall!.args).toContain('feat-x');

    // A log message mentioning zero turns was emitted
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/zero turns/i);
    expect(logged).toContain(handle.path);
  });

  it('cleanup with force:true swallows worktree remove failure and warns', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('worktree') && args.includes('remove')) {
        const err = Object.assign(
          new Error("fatal: cannot remove worktree: locked"),
          { stderr: "fatal: cannot remove worktree: locked\n", stdout: '' },
        );
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handle.cleanup({ force: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/worktree remove/i);
  });

  it('cleanup with force:true after worktree already removed is a safe no-op', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('worktree') && args.includes('remove')) {
        throw Object.assign(new Error('no such worktree'), { stderr: 'no such worktree\n', stdout: '' });
      }
      if (args.includes('branch') && args.includes('-d')) {
        throw Object.assign(new Error('branch not found'), { stderr: 'branch not found\n', stdout: '' });
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('feat-x', { execFile: mock });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Both remove and branch-delete fail, but the call still resolves cleanly
    await expect(handle.cleanup({ force: true })).resolves.toBeUndefined();
  });
});

describe('setupWorktree — branch prefix', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-prefix-test-')));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
    delete process.env['AFK_WORKTREE_BRANCH_PREFIX'];
    vi.restoreAllMocks();
  });

  it('honors opts.branchPrefix override for auto-generated names', async () => {
    const mock = makeMock(defaultHandler(repoRoot));
    const handle = await setupWorktree(true, { execFile: mock, branchPrefix: 'scratch/' });
    expect(handle.branch).toMatch(/^scratch\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it('honors AFK_WORKTREE_BRANCH_PREFIX env var', async () => {
    process.env['AFK_WORKTREE_BRANCH_PREFIX'] = 'work/';
    const mock = makeMock(defaultHandler(repoRoot));
    const handle = await setupWorktree(true, { execFile: mock });
    expect(handle.branch).toMatch(/^work\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it('opts.branchPrefix beats env var', async () => {
    process.env['AFK_WORKTREE_BRANCH_PREFIX'] = 'work/';
    const mock = makeMock(defaultHandler(repoRoot));
    const handle = await setupWorktree(true, {
      execFile: mock,
      branchPrefix: 'scratch/',
    });
    expect(handle.branch).toMatch(/^scratch\//);
  });

  it('explicit branch name ignores any prefix override', async () => {
    process.env['AFK_WORKTREE_BRANCH_PREFIX'] = 'work/';
    const mock = makeMock(defaultHandler(repoRoot));
    const handle = await setupWorktree('my-explicit-name', {
      execFile: mock,
      branchPrefix: 'scratch/',
    });
    expect(handle.branch).toBe('my-explicit-name');
  });

  // Regression — env-sourced branch prefix is concatenated into
  // `git worktree add -b <prefix><slug>`, so any character that looks
  // like a CLI flag, shell metacharacter, or path-traversal sequence must
  // be rejected before reaching the git invocation.
  it.each([
    ['--force/', /must not start with '-'/],
    ['$(rm -rf /)/', /only \[A-Za-z0-9_-.\/\]/],
    ['work\nrm/', /only \[A-Za-z0-9_-.\/\]/],
    ['work;ls/', /only \[A-Za-z0-9_-.\/\]/],
    ['a'.repeat(65), /length 65 exceeds 64/],
  ])('rejects AFK_WORKTREE_BRANCH_PREFIX=%s', async (value, pattern) => {
    process.env['AFK_WORKTREE_BRANCH_PREFIX'] = value;
    const mock = makeMock(defaultHandler(repoRoot));
    await expect(setupWorktree(true, { execFile: mock })).rejects.toThrow(pattern);
    // No git call should fire — the prefix must be vetted at resolve time.
    expect(mock.calls.length).toBe(0);
  });

  it('accepts conservative prefix characters from env', async () => {
    process.env['AFK_WORKTREE_BRANCH_PREFIX'] = 'feature_team-1.x/';
    const mock = makeMock(defaultHandler(repoRoot));
    const handle = await setupWorktree(true, { execFile: mock });
    expect(handle.branch).toMatch(/^feature_team-1\.x\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });
});

describe('setupWorktreeDeferred (born-named)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-deferred-test-')));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('resolves repo root + ensures .gitignore up front, but defers `git worktree add` until create()', async () => {
    const mock = makeMock(defaultHandler(repoRoot));
    const deferred = await setupWorktreeDeferred({ execFile: mock });

    // Eager work done: repo root resolved, .gitignore entry written.
    expect(deferred.repoRoot).toBe(repoRoot);
    const gitignore = await fs.readFile(join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.afk-worktrees/');
    // Deferred work NOT done: no handle, no `git worktree add` yet.
    expect(deferred.handle()).toBeUndefined();
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);

    const handle = await deferred.create('afk/fix-cleanup-race');
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(true);
    expect(handle.branch).toBe('afk/fix-cleanup-race');
    expect(handle.path.endsWith('/.afk-worktrees/afk-fix-cleanup-race')).toBe(true);
    expect(deferred.handle()).toBe(handle);
  });

  it('fails fast when not inside a git repository (before any deferral)', async () => {
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'fatal: not a git repository\n',
          stdout: '',
        });
      }
      return { stdout: '', stderr: '' };
    });
    await expect(setupWorktreeDeferred({ execFile: mock })).rejects.toThrow(
      /Not in a git repository/,
    );
  });

  it('create() is idempotent — a second call returns the same handle without a second add', async () => {
    const mock = makeMock(defaultHandler(repoRoot));
    const deferred = await setupWorktreeDeferred({ execFile: mock });

    const first = await deferred.create('afk/fix-cleanup-race');
    const addsAfterFirst = mock.calls.filter((c) => c.args.includes('add')).length;
    const second = await deferred.create('afk/some-other-name');

    expect(second).toBe(first);
    expect(second.branch).toBe('afk/fix-cleanup-race'); // 2nd arg ignored
    expect(mock.calls.filter((c) => c.args.includes('add')).length).toBe(addsAfterFirst);
  });

  it('create(true) auto-generates a timestamp branch (fallback path)', async () => {
    const mock = makeMock(defaultHandler(repoRoot));
    const deferred = await setupWorktreeDeferred({ execFile: mock });
    const handle = await deferred.create(true);
    expect(handle.branch).toMatch(/^afk\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });
});

describe('setupWorktree — base ref (--worktree-base / AFK_WORKTREE_BASE)', () => {
  let repoRoot: string;
  const SAVED_BASE = process.env['AFK_WORKTREE_BASE'];

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-worktree-base-test-')));
    delete process.env['AFK_WORKTREE_BASE'];
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Restore env so a leaked AFK_WORKTREE_BASE can't poison sibling suites.
    if (SAVED_BASE === undefined) delete process.env['AFK_WORKTREE_BASE'];
    else process.env['AFK_WORKTREE_BASE'] = SAVED_BASE;
    vi.restoreAllMocks();
  });

  /**
   * Handler for base-ref tests: resolves git-common-dir → repoRoot, returns a
   * stub SHA for `rev-parse --verify <ref>^{commit}`, lists `remotes` for
   * `git remote`, and succeeds on fetch / worktree add. Knobs simulate fetch
   * failure and unresolvable refs.
   */
  function baseRefHandler(
    root: string,
    opts?: { remotes?: string[]; resolvedSha?: string; failFetch?: boolean; failVerify?: boolean },
  ): ExecHandler {
    const remotes = opts?.remotes ?? ['origin'];
    const resolvedSha = opts?.resolvedSha ?? 'a'.repeat(40);
    return async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${root}/.git\n`, stderr: '' };
      }
      if (args.includes('rev-parse') && args.includes('--verify')) {
        if (opts?.failVerify) {
          throw Object.assign(new Error('Command failed'), {
            stderr: 'fatal: Needed a single revision\n',
            stdout: '',
          });
        }
        return { stdout: `${resolvedSha}\n`, stderr: '' };
      }
      if (args.includes('remote')) {
        return { stdout: `${remotes.join('\n')}\n`, stderr: '' };
      }
      if (args.includes('fetch')) {
        if (opts?.failFetch) {
          throw Object.assign(new Error('Command failed'), {
            stderr: 'fatal: unable to access remote\n',
            stdout: '',
          });
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
  }

  /** The SHA is appended as the commit-ish (last arg) of `git worktree add`. */
  function addCommitish(mock: MockExecFile): string | undefined {
    const addCall = mock.calls.find((c) => c.args.includes('worktree') && c.args.includes('add'));
    return addCall?.args[addCall.args.length - 1];
  }

  it('bases the branch on a local ref WITHOUT fetching (no remote match)', async () => {
    const sha = 'c'.repeat(40);
    // 'feature' is not a configured remote → treat 'feature/x' as a local ref.
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha }));

    await setupWorktree('wt-local', { execFile: mock, baseRef: 'feature/x' });

    // No fetch attempted for a non-remote ref.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(false);
    // Ref resolved via `rev-parse --verify feature/x^{commit}`.
    const verify = mock.calls.find((c) => c.args.includes('--verify'));
    expect(verify?.args).toContain('feature/x^{commit}');
    // Resolved SHA passed as the commit-ish to `git worktree add`.
    expect(addCommitish(mock)).toBe(sha);
  });

  it('fetches a remote ref (origin/main) before basing the worktree on it', async () => {
    const sha = 'd'.repeat(40);
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha }));

    await setupWorktree('wt-remote', { execFile: mock, baseRef: 'origin/main' });

    // origin is a known remote → fetch its branch first.
    const fetch = mock.calls.find((c) => c.args.includes('fetch'));
    expect(fetch).toBeDefined();
    expect(fetch!.args).toEqual(['-C', repoRoot, 'fetch', '--no-tags', 'origin', 'main']);
    // Then resolve + base on the fetched ref.
    const verify = mock.calls.find((c) => c.args.includes('--verify'));
    expect(verify?.args).toContain('origin/main^{commit}');
    expect(addCommitish(mock)).toBe(sha);
  });

  it('DEFAULTS to the remote default branch (origin/HEAD) when no base ref is set', async () => {
    const sha = '4'.repeat(40);
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'origin\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--verify')) {
        return { stdout: `${sha}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    // No baseRef passed — the remote default is detected + fetched + used.
    await setupWorktree('wt-auto', { execFile: mock });

    expect(mock.calls.some((c) => c.args.includes('symbolic-ref'))).toBe(true);
    const fetch = mock.calls.find((c) => c.args.includes('fetch'));
    expect(fetch!.args).toEqual(['-C', repoRoot, 'fetch', '--no-tags', 'origin', 'main']);
    expect(addCommitish(mock)).toBe(sha);
  });

  it('detects origin/main via fallback when origin/HEAD is unset', async () => {
    const sha = '5'.repeat(40);
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('symbolic-ref')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n',
          stdout: '',
        });
      }
      if (args.includes('remote')) return { stdout: 'origin\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--verify')) {
        return { stdout: `${sha}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await setupWorktree('wt-fallback', { execFile: mock });

    const fetch = mock.calls.find((c) => c.args.includes('fetch'));
    expect(fetch!.args).toEqual(['-C', repoRoot, 'fetch', '--no-tags', 'origin', 'main']);
    expect(addCommitish(mock)).toBe(sha);
  });

  it('soft-falls back to local HEAD when no remote default is discoverable', async () => {
    // defaultHandler: origin/HEAD unset + origin/main|master tracking refs absent.
    const mock = makeMock(defaultHandler(repoRoot));

    await setupWorktree('wt-default', { execFile: mock });

    const addCall = mock.calls.find((c) => c.args.includes('worktree') && c.args.includes('add'));
    // Last arg is the worktree path, NOT a commit-ish — git defaults to HEAD.
    expect(addCall!.args[addCall!.args.length - 1]!.endsWith('/.afk-worktrees/wt-default')).toBe(true);
    // No remote default to refresh → no fetch.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(false);
  });

  it('soft-falls back to local HEAD when the detected default ref cannot be resolved', async () => {
    // origin/HEAD points at origin/main, but resolving it fails (e.g. never
    // fetched + offline). The default path must NOT throw — it bases on HEAD.
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'origin\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--verify')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'fatal: bad revision\n',
          stdout: '',
        });
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('wt-soft', { execFile: mock });

    const addCall = mock.calls.find((c) => c.args.includes('worktree') && c.args.includes('add'));
    expect(addCall!.args[addCall!.args.length - 1]!.endsWith('/.afk-worktrees/wt-soft')).toBe(true);
    expect(handle.branch).toBe('wt-soft'); // creation succeeded — no throw
  });

  it('--worktree-base HEAD opts out of the remote default (local checkout, no detection, no fetch)', async () => {
    const sha = '6'.repeat(40);
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('rev-parse') && args.includes('--verify')) {
        return { stdout: `${sha}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await setupWorktree('wt-head', { execFile: mock, baseRef: 'HEAD' });

    // Explicit ref short-circuits remote-default detection entirely.
    expect(mock.calls.some((c) => c.args.includes('symbolic-ref'))).toBe(false);
    // HEAD has no remote prefix → no fetch.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(false);
    const verify = mock.calls.find((c) => c.args.includes('--verify'));
    expect(verify?.args).toContain('HEAD^{commit}');
    expect(addCommitish(mock)).toBe(sha);
  });

  it('proceeds (with a warning) when fetching the remote ref fails — uses local copy', async () => {
    const sha = 'e'.repeat(40);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = makeMock(
      baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha, failFetch: true }),
    );

    const handle = await setupWorktree('wt-offline', { execFile: mock, baseRef: 'origin/main' });

    // Fetch was attempted and failed, but creation still succeeded on the
    // resolvable (stale) local copy.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not fetch 'origin\/main'/));
    expect(addCommitish(mock)).toBe(sha);
    expect(handle.branch).toBe('wt-offline');
  });

  it('throws a clear error when the base ref cannot be resolved', async () => {
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: [], failVerify: true }));

    await expect(
      setupWorktree('wt-badref', { execFile: mock, baseRef: 'no-such-ref' }),
    ).rejects.toThrow(/Cannot resolve worktree base ref 'no-such-ref'/);
  });

  it('rejects a base ref that would be parsed as a git flag', async () => {
    const mock = makeMock(baseRefHandler(repoRoot));

    await expect(
      setupWorktree('wt-flag', { execFile: mock, baseRef: '--upload-pack=evil' }),
    ).rejects.toThrow(/must not start with '-'/);
    // Guard fires before any fetch/rev-parse touches git.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(false);
  });

  it('falls back to AFK_WORKTREE_BASE when no explicit baseRef is passed', async () => {
    const sha = 'f'.repeat(40);
    process.env['AFK_WORKTREE_BASE'] = 'origin/main';
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha }));

    // No baseRef in opts → resolveBaseRef reads the env var.
    await setupWorktree('wt-env', { execFile: mock });

    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(true);
    expect(addCommitish(mock)).toBe(sha);
  });

  it('explicit baseRef opt overrides AFK_WORKTREE_BASE', async () => {
    const sha = '1'.repeat(40);
    process.env['AFK_WORKTREE_BASE'] = 'origin/main';
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha }));

    await setupWorktree('wt-override', { execFile: mock, baseRef: 'v1.2.3' });

    // v1.2.3 is not remote/<branch> → no fetch; the env value is ignored.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(false);
    const verify = mock.calls.find((c) => c.args.includes('--verify'));
    expect(verify?.args).toContain('v1.2.3^{commit}');
  });

  it('records the resolved base SHA and ref string in .afk-worktree-meta.json', async () => {
    const sha = '2'.repeat(40);
    const mock = makeMock(async ({ args }) => {
      if (args.includes('rev-parse') && args.includes('--git-common-dir')) {
        return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      }
      if (args.includes('rev-parse') && args.includes('--verify')) {
        return { stdout: `${sha}\n`, stderr: '' };
      }
      if (args.includes('remote')) return { stdout: 'origin\n', stderr: '' };
      if (args.includes('worktree') && args.includes('add')) {
        // Create the worktree dir so the best-effort meta write lands on disk.
        const pathArg = args.find((a) => a.includes('.afk-worktrees'));
        if (pathArg) await fs.mkdir(pathArg, { recursive: true });
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const handle = await setupWorktree('wt-meta', { execFile: mock, baseRef: 'origin/main' });
    const meta = JSON.parse(
      await fs.readFile(join(handle.path, '.afk-worktree-meta.json'), 'utf8'),
    ) as { baseSha: string; baseBranch: string };
    expect(meta.baseSha).toBe(sha);
    expect(meta.baseBranch).toBe('origin/main');
  });

  it('pre-resolves explicit baseRef during deferred setup and reuses the SHA at create()', async () => {
    const sha = '3'.repeat(40);
    const mock = makeMock(baseRefHandler(repoRoot, { remotes: ['origin'], resolvedSha: sha }));

    const deferred = await setupWorktreeDeferred({ execFile: mock, baseRef: 'origin/main' });
    // Explicit base refs fail fast at setup, but the worktree add remains deferred.
    expect(mock.calls.some((c) => c.args.includes('fetch'))).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('--verify'))).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);

    const callsBeforeCreate = mock.calls.length;
    await deferred.create('afk/born-named');
    const createCalls = mock.calls.slice(callsBeforeCreate);
    expect(createCalls.some((c) => c.args.includes('fetch'))).toBe(false);
    expect(createCalls.some((c) => c.args.includes('--verify'))).toBe(false);
    expect(addCommitish(mock)).toBe(sha);
  });

  it('fails deferred setup before first-turn fallback when an explicit base ref is invalid', async () => {
    const mock = makeMock(baseRefHandler(repoRoot, { failVerify: true }));

    await expect(
      setupWorktreeDeferred({ execFile: mock, baseRef: 'no-such-ref' }),
    ).rejects.toThrow(/Cannot resolve worktree base ref 'no-such-ref'/);
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
  });

  it('fails deferred setup before first-turn fallback when AFK_WORKTREE_BASE is invalid', async () => {
    process.env['AFK_WORKTREE_BASE'] = 'missing-env-ref';
    const mock = makeMock(baseRefHandler(repoRoot, { failVerify: true }));

    await expect(setupWorktreeDeferred({ execFile: mock })).rejects.toThrow(
      /Cannot resolve worktree base ref 'missing-env-ref'/,
    );
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
  });
});
