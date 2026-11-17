/**
 * Tests for the `.afk-scratch/` agent scratch dir: the shared info/exclude
 * entry, and the end-to-end isolated-subagent teardown behaviour it buys.
 * The `afk -w` session-cleanup path is covered in
 * `cli/commands/interactive/worktree.scratch.test.ts` (layer rule: agent/ must
 * not import cli/).
 *
 * Real git repos under os.tmpdir(); never touches the real checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileNode } from 'node:child_process';
import { promises as fs, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  AFK_SCRATCH_EXCLUDE_PATTERN,
  ensureScratchExcluded,
  excludeHasScratchEntry,
} from './worktree-scratch.js';
import { createManagedWorktree, teardownIsolatedWorktree } from '../tools/handlers/worktree-managed.js';
import type { ExecFileFn } from './worktree-sweep.js';

const execFile = promisify(execFileNode) as ExecFileFn;

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execFile('git', ['-C', cwd, ...args]);
  return r.stdout.trim();
}

let repo: string;

/** Repo with one commit; `.gitignore` ignores the meta file like this repo does. */
async function initRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'afk-scratch-')));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 't@example.com']);
  await git(dir, ['config', 'user.name', 't']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(join(dir, '.gitignore'), '.afk-worktrees/\n.afk-worktree-meta.json\n*.local.txt\n');
  await git(dir, ['add', '.gitignore']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

async function makeManagedTree(slug: string): Promise<string> {
  const wt = join(repo, '.afk-worktrees', slug);
  await createManagedWorktree({ execFile, repoRoot: repo, worktreePath: wt, branch: `afk/${slug}`, baseRef: 'HEAD' });
  return wt;
}

async function readExclude(): Promise<string> {
  return fs.readFile(join(repo, '.git', 'info', 'exclude'), 'utf-8');
}

async function isLocked(wt: string): Promise<boolean> {
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  const block = list.split('\n\n').find((b) => b.startsWith(`worktree ${wt}`));
  return block?.split('\n').some((l) => l.startsWith('locked')) ?? false;
}

beforeEach(async () => {
  repo = await initRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('ensureScratchExcluded', () => {
  it('appends the anchored pattern once (idempotent) and keeps prior content', async () => {
    await fs.writeFile(join(repo, '.git', 'info', 'exclude'), '# existing\nfoo/');
    expect(await ensureScratchExcluded(execFile, repo)).toBe(true);
    expect(await ensureScratchExcluded(execFile, repo)).toBe(true);
    const content = await readExclude();
    expect(content.startsWith('# existing\nfoo/\n')).toBe(true);
    expect(content.split('\n').filter((l) => l === AFK_SCRATCH_EXCLUDE_PATTERN)).toHaveLength(1);
  });

  it('writes to the SHARED common dir when called from a linked worktree', async () => {
    const wt = join(repo, '.afk-worktrees', 'linked');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/linked', wt]);
    expect(await ensureScratchExcluded(execFile, wt)).toBe(true);
    expect(excludeHasScratchEntry(await readExclude())).toBe(true);
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'PR_BODY.md'), 'body');
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('fails safe: returns false (never throws) outside a git repo', async () => {
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-scratch-nogit-')));
    try {
      expect(await ensureScratchExcluded(execFile, notRepo)).toBe(false);
      expect(existsSync(join(notRepo, 'info'))).toBe(false);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('fails safe when the git runner throws', async () => {
    const throwing = (async () => { throw new Error('git missing'); }) as ExecFileFn;
    expect(await ensureScratchExcluded(throwing, repo)).toBe(false);
  });

  it('recognises an existing unanchored entry as already present', () => {
    expect(excludeHasScratchEntry('.afk-scratch/\n')).toBe(true);
    expect(excludeHasScratchEntry('# .afk-scratch/\n')).toBe(false);
  });
});

describe('isolated-worktree teardown with .afk-scratch/', () => {
  it('createManagedWorktree ensures the exclude entry', async () => {
    await makeManagedTree('create');
    expect(excludeHasScratchEntry(await readExclude())).toBe(true);
  });

  it('a tree whose only extra content is .afk-scratch/ files is removed, not locked', async () => {
    const wt = await makeManagedTree('scratch-only');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'COMMIT_BODY.txt'), 'msg');
    // Gitignored by the repo AND inside scratch: still disposable, no ignored-local-state.
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.local.txt'), 'x');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('a tree created BEFORE the exclude existed still benefits (re-ensured at teardown)', async () => {
    const wt = join(repo, '.afk-worktrees', 'legacy');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/legacy', wt]);
    expect(existsSync(join(repo, '.git', 'info', 'exclude')) && excludeHasScratchEntry(await readExclude())).toBe(false);
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'pr-body.txt'), 'b');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result.removed).toBe(true);
  });

  it('an untracked file outside .afk-scratch/ still preserves and locks as dirty', async () => {
    const wt = await makeManagedTree('dirty');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'ok.txt'), 'x');
    await fs.writeFile(join(wt, 'pr-body.txt'), 'stray');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });
    expect(await isLocked(wt)).toBe(true);
  });

  it('a nested sub/.afk-scratch/ is NOT the sanctioned dir and still reads dirty', async () => {
    const wt = await makeManagedTree('nested');
    await fs.mkdir(join(wt, 'sub', '.afk-scratch'), { recursive: true });
    await fs.writeFile(join(wt, 'sub', '.afk-scratch', 'x.txt'), 'x');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toMatchObject({ removed: false, preserved: true, reason: 'dirty' });
  });

  it('a non-rebuildable ignored file outside .afk-scratch/ still locks as ignored-local-state', async () => {
    const wt = await makeManagedTree('ignored');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'ok.txt'), 'x');
    await fs.writeFile(join(wt, 'commit-msg.local.txt'), 'kept');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toMatchObject({ removed: false, preserved: true, reason: 'ignored-local-state', ignoredDetail: 'commit-msg.local.txt' });
    expect(await isLocked(wt)).toBe(true);
  });
});
