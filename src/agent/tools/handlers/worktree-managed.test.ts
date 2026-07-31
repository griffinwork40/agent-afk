/**
 * Tests for the factored-out managed-worktree primitives shared by the
 * `worktree` tool handler and the `agent` tool's isolation:"worktree" path.
 *
 * Uses a mocked ExecFileFn (same pattern as worktree.test.ts) so no real git
 * runs. Focus: the git argv emitted (parity with the pre-extraction handler)
 * and the create/teardown decision logic for isolated worktrees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createManagedWorktree,
  removeManagedWorktreeGuarded,
  createIsolatedWorktree,
  teardownIsolatedWorktree,
} from './worktree-managed.js';
import type { ExecFileFn } from '../../worktree-sweep.js';

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

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'wt-managed-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('createManagedWorktree — argv + meta parity', () => {
  it('emits `git worktree add -b <branch> <path> <baseRef>` and writes meta', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'feat');
    const mock = makeMock((call) => {
      if (call.args.includes('add')) {
        return fs.mkdir(wtPath, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'base-sha-999\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const info = await createManagedWorktree({
      execFile: mock,
      repoRoot,
      worktreePath: wtPath,
      branch: 'afk/feat',
      baseRef: 'HEAD',
    });
    expect(info).toEqual({ path: wtPath, branch: 'afk/feat', baseRef: 'HEAD', baseSha: 'base-sha-999' });
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toEqual(['-C', repoRoot, 'worktree', 'add', '-b', 'afk/feat', wtPath, 'HEAD']);
    const meta = JSON.parse(await fs.readFile(join(wtPath, '.afk-worktree-meta.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta['owner']).toBe('agent');
    expect(meta['baseSha']).toBe('base-sha-999');
    expect(meta['pid']).toBe(process.pid);
  });
});

describe('removeManagedWorktreeGuarded — guards + argv', () => {
  it('removes a clean tree with no --force', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'clean');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({
      execFile: mock, repoRoot, worktreePath: wtPath, branch: 'refs/heads/afk/clean',
    });
    expect(outcome).toEqual({ removed: true, branchPreserved: 'refs/heads/afk/clean' });
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toEqual(['-C', repoRoot, 'worktree', 'remove', wtPath]);
    expect(rm?.args).not.toContain('--force');
  });

  it('refuses a dirty tree without force (reason: dirty)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'dirty');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: ' M f.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'dirty' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('refuses a commits-ahead tree without force (reason: commits-ahead)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'ahead');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(join(wtPath, '.afk-worktree-meta.json'), JSON.stringify({ baseSha: 'base1' }));
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse')) return { stdout: 'tip9\n', stderr: '' };
      if (call.args.includes('rev-list')) return { stdout: '3\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'commits-ahead', commitsAhead: 3 });
  });

  it('force removes with --force, skipping guards', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'force');
    const mock = makeMock(() => ({ stdout: ' M dirty.ts\n', stderr: '' }));
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath, force: true });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toContain('--force');
    // No status check when forced.
    expect(mock.calls.some((c) => c.args.includes('status'))).toBe(false);
  });

  // #759 (second removal path): bare `status --porcelain` never reports
  // ignored files, so a tree whose only content is a non-rebuildable ignored
  // file (`.env`) reads clean and reached `git worktree remove` undefended.
  it('refuses a tree holding a non-rebuildable ignored file without force (reason: ignored-local-state)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'has-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n!! node_modules/\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' }; // tracked tree is clean
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome).toEqual({ removed: false, reason: 'ignored-local-state' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  // Counterweight: ignored build output alone must NOT block removal, or
  // every worktree with node_modules/ would become unreapable.
  it('still succeeds when the only ignored content is rebuildable output', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'only-build-output');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! node_modules/\n!! dist/\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toEqual(['-C', repoRoot, 'worktree', 'remove', wtPath]);
  });

  it('force:true still removes even when non-rebuildable ignored content is present', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'force-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await removeManagedWorktreeGuarded({
      execFile: mock, repoRoot, worktreePath: wtPath, force: true,
    });
    expect(outcome.removed).toBe(true);
    const rm = mock.calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toContain('--force');
    // Explicit override bypasses the ignored-state probe entirely.
    expect(mock.calls.some((c) => c.args.includes('--ignored'))).toBe(false);
  });
});

describe('createIsolatedWorktree', () => {
  it("resolves the repo root and creates an afk/iso-* branch based on the anchor's HEAD", async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) {
        const p = call.args[call.args.length - 2] as string; // <path> <baseRef>
        return fs.mkdir(p, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'headsha\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const iso = await createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-diagnose-1-abc123' });
    expect(iso.repoRoot).toBe(repoRoot);
    expect(iso.path).toBe(join(repoRoot, '.afk-worktrees', 'iso-diagnose-1-abc123'));
    expect(iso.branch).toBe('afk/iso-diagnose-1-abc123');
    // #760: the default base is the anchor's RESOLVED HEAD sha, not the literal
    // ref (which `git -C <repoRoot>` would resolve at the MAIN checkout instead).
    expect(iso.baseRef).toBe('headsha');
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toEqual([
      '-C', repoRoot, 'worktree', 'add', '-b', 'afk/iso-diagnose-1-abc123', iso.path, 'headsha',
    ]);
  });

  it('throws when cwd is not a git repository (executor must fail loud, not fall back)', async () => {
    const mock = makeMock(() => { throw new Error('fatal: not a git repository'); });
    await expect(
      createIsolatedWorktree({ execFile: mock, cwd: '/nowhere', slugHint: 'iso-x-1-y' }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('retries once on a lock error then succeeds (concurrent worktree add contention)', async () => {
    let addCount = 0;
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) {
        addCount += 1;
        if (addCount === 1) {
          // First parallel `worktree add` loses the index-lock race.
          throw new Error('fatal: could not lock ref; another worktree add is in progress (index.lock)');
        }
        const p = call.args[call.args.length - 2] as string; // <path> <baseRef>
        return fs.mkdir(p, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse')) return { stdout: 'headsha\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const iso = await createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-parallel-2-def456' });
    expect(iso.repoRoot).toBe(repoRoot);
    expect(iso.path).toBe(join(repoRoot, '.afk-worktrees', 'iso-parallel-2-def456'));
    expect(iso.branch).toBe('afk/iso-parallel-2-def456');
    expect(iso.baseRef).toBe('headsha');
    // Retried EXACTLY once → `worktree add` invoked twice, second time won.
    expect(mock.calls.filter((c) => c.args.includes('add'))).toHaveLength(2);
  });

  it('does NOT retry a non-lock error (deterministic failures propagate immediately)', async () => {
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('add')) throw new Error('fatal: something else');
      return { stdout: '', stderr: '' };
    });
    await expect(
      createIsolatedWorktree({ execFile: mock, cwd: repoRoot, slugHint: 'iso-nonlock-3-ghi789' }),
    ).rejects.toThrow(/something else/);
    // No retry → `worktree add` invoked exactly once.
    expect(mock.calls.filter((c) => c.args.includes('add'))).toHaveLength(1);
  });
});

describe('teardownIsolatedWorktree', () => {
  it('removes a clean worktree', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-clean');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(false);
  });

  it('preserves + locks a dirty worktree (WIP never destroyed)', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-dirty');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: ' M wip.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
    const lock = mock.calls.find((c) => c.args.includes('lock'));
    expect(lock?.args[0]).toBe('-C');
    expect(lock?.args).toContain(wtPath);
    expect(lock?.args.join(' ')).toContain('afk: isolated-worktree preserved (dirty)');
  });

  it('never throws — a git failure degrades to removed:false, preserved:false', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-boom');
    const mock = makeMock((call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('remove')) throw new Error('git remove exploded');
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: false });
  });

  // The tree LOOKS clean to `git status`, so the lock reason is the only
  // place the operator can learn WHY it was preserved instead of removed.
  it('preserves + locks a tree holding non-rebuildable ignored files, naming the reason', async () => {
    const wtPath = join(repoRoot, '.afk-worktrees', 'iso-has-dotenv');
    const mock = makeMock((call) => {
      if (call.args.includes('--ignored')) return { stdout: '!! .env\n', stderr: '' };
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const result = await teardownIsolatedWorktree({ execFile: mock, repoRoot, worktreePath: wtPath });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'ignored-local-state' });
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
    const lock = mock.calls.find((c) => c.args.includes('lock'));
    expect(lock?.args.join(' ')).toContain('afk: isolated-worktree preserved (ignored-local-state');
    // Legible without needing to already know the reason code.
    expect(lock?.args.join(' ')).toMatch(/non-rebuildable ignored files/);
  });
});
