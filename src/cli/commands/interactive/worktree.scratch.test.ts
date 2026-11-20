/**
 * `afk -w` session cleanup and the `.afk-scratch/` agent scratch dir: scratch
 * files alone are disposable only with creation-time opt-in, and the afk meta
 * file alone never preserves the tree (it is excluded for every tree). Other
 * untracked files still preserve the tree. Real git repos under os.tmpdir();
 * never touches the real checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileNode } from 'node:child_process';
import { promises as fs, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { runWorktreeCleanup } from './worktree.cleanup.js';
import { setupWorktree } from './worktree.js';
import {
  ensureAfkExcludes,
  excludeHasScratchEntry,
  excludeHasMetaEntry,
  AFK_SCRATCH_EXCLUDE_PATTERN,
  AFK_META_EXCLUDE_PATTERN,
} from '../../../agent/worktree/worktree-scratch.js';
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
  // The meta file is deliberately NOT gitignored: the shared exclude must cover it.
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
    // The resolver anchors relative git-dir output to process.cwd(), so have
    // real git return an absolute path while the runner stays in the temp repo.
    const inTempRepo: ExecFileFn = (file, args, opts) => execFile(file,
      args.flatMap((arg) => arg === '--git-common-dir' ? ['--path-format=absolute', arg] : [arg]),
      { ...opts, cwd: repo });
    const handle = await setupWorktree('i-scratch', { execFile: inTempRepo });
    const wt = handle.path;
    const meta = JSON.parse(await fs.readFile(join(wt, '.afk-worktree-meta.json'), 'utf-8'));
    expect(meta.scratchDisposable).toBe(true);
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

  it.each([false, true])('preserves scratch without opt-in (shared exclude already present: %s)', async (excluded) => {
    const wt = await makeTree('i-legacy');
    if (excluded) await ensureAfkExcludes(execFile, repo);
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.md'), 'keep');
    await runWorktreeCleanup({ worktreePath: wt, branch: 'i-legacy', repoRoot: repo, execFile });
    expect(await fs.readFile(join(wt, '.afk-scratch', 'notes.md'), 'utf-8')).toBe('keep');
  });

  it('still preserves a tree with an untracked file outside .afk-scratch/', async () => {
    const wt = await makeTree('i-dirty');
    await fs.writeFile(join(wt, '.pr-body.md'), 'stray');
    await runWorktreeCleanup({ worktreePath: wt, branch: 'i-dirty', repoRoot: repo, execFile });
    expect(existsSync(join(wt, '.pr-body.md'))).toBe(true);
  });
});

// Item 3: create-time exclude write on the `afk -w` path.
//
// `setupWorktree` calls `ensureAfkExcludes` before returning the handle.
// The existing test only checks `meta.scratchDisposable`; it also re-runs
// cleanup which would re-call ensureAfkExcludes and hide whether the
// creation-time write happened. These tests read the exclude file immediately
// after `setupWorktree` returns, before any cleanup path runs.
describe('afk -w create-time exclude write (item 3)', () => {
  // Build an ExecFileFn that forces git to return an absolute path for
  // --git-common-dir so the resolver works regardless of process.cwd().
  function makeInTempRepoExec(): ExecFileFn {
    return (file, args, opts) =>
      execFile(
        file,
        args.flatMap((arg) =>
          arg === '--git-common-dir' ? ['--path-format=absolute', arg] : [arg],
        ),
        { ...opts, cwd: repo },
      );
  }

  it('setupWorktree writes both AFK exclude entries before cleanup runs', async () => {
    const inTempRepo = makeInTempRepoExec();
    const handle = await setupWorktree('i-excl', { execFile: inTempRepo });
    // Read the exclude file NOW — before cleanup touches it.
    const excludePath = join(repo, '.git', 'info', 'exclude');
    const content = await fs.readFile(excludePath, 'utf-8');
    expect(excludeHasScratchEntry(content)).toBe(true);
    expect(excludeHasMetaEntry(content)).toBe(true);
    // Both anchored patterns must appear.
    expect(content).toContain(AFK_SCRATCH_EXCLUDE_PATTERN);
    expect(content).toContain(AFK_META_EXCLUDE_PATTERN);
    // Suppress the cleanup that would otherwise leave a dangling worktree.
    await handle.cleanup({ force: true });
  });

  it('setupWorktree writes the exclude even when info/exclude did not previously exist', async () => {
    // Remove the info dir so ensureAfkExcludes must create it from scratch.
    await fs.rm(join(repo, '.git', 'info'), { recursive: true, force: true });
    const inTempRepo = makeInTempRepoExec();
    const handle = await setupWorktree('i-excl-fresh', { execFile: inTempRepo });
    const excludePath = join(repo, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);
    const content = await fs.readFile(excludePath, 'utf-8');
    expect(excludeHasScratchEntry(content)).toBe(true);
    expect(excludeHasMetaEntry(content)).toBe(true);
    await handle.cleanup({ force: true });
  });

  it('the exclude write is idempotent: a second setupWorktree does not duplicate entries', async () => {
    const inTempRepo = makeInTempRepoExec();
    const h1 = await setupWorktree('i-idem-a', { execFile: inTempRepo });
    const h2 = await setupWorktree('i-idem-b', { execFile: inTempRepo });
    const content = await fs.readFile(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    // Each pattern must appear exactly once despite two setupWorktree calls.
    expect(content.split('\n').filter((l) => l === AFK_SCRATCH_EXCLUDE_PATTERN)).toHaveLength(1);
    expect(content.split('\n').filter((l) => l === AFK_META_EXCLUDE_PATTERN)).toHaveLength(1);
    await h1.cleanup({ force: true });
    await h2.cleanup({ force: true });
  });
});
