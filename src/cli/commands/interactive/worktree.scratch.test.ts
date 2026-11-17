/**
 * `afk -w` session cleanup and the `.afk-scratch/` agent scratch dir: scratch
 * files alone must not preserve the tree, while any other untracked file still
 * does. Real git repos under os.tmpdir(); never touches the real checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileNode } from 'node:child_process';
import { promises as fs, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { runWorktreeCleanup } from './worktree.cleanup.js';
import type { ExecFileFn } from './worktree.js';

const execFile = promisify(execFileNode) as ExecFileFn;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile('git', ['-C', cwd, ...args]);
}

let repo: string;

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-w-scratch-')));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 't@example.com']);
  await git(repo, ['config', 'user.name', 't']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(join(repo, '.gitignore'), '.afk-worktrees/\n');
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

async function makeTree(slug: string): Promise<string> {
  const wt = join(repo, '.afk-worktrees', slug);
  await git(repo, ['worktree', 'add', '-q', '-b', slug, wt]);
  return wt;
}

describe('afk -w session cleanup with .afk-scratch/', () => {
  it('removes a tree whose only extra content is .afk-scratch/ files', async () => {
    const wt = await makeTree('i-scratch');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'issue-comment.md'), 'c');
    await runWorktreeCleanup({ worktreePath: wt, branch: 'i-scratch', repoRoot: repo, execFile });
    expect(existsSync(wt)).toBe(false);
  });

  it('removes a tree whose only extra content is the afk meta file', async () => {
    const wt = await makeTree('i-meta');
    await fs.writeFile(join(wt, '.afk-worktree-meta.json'), '{"owner":"interactive"}');
    await runWorktreeCleanup({ worktreePath: wt, branch: 'i-meta', repoRoot: repo, execFile });
    expect(existsSync(wt)).toBe(false);
  });

  it('still preserves a tree with an untracked file outside .afk-scratch/', async () => {
    const wt = await makeTree('i-dirty');
    await fs.writeFile(join(wt, '.pr-body.md'), 'stray');
    await runWorktreeCleanup({ worktreePath: wt, branch: 'i-dirty', repoRoot: repo, execFile });
    expect(existsSync(join(wt, '.pr-body.md'))).toBe(true);
  });
});
