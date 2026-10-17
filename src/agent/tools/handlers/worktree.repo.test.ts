import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSyncRetry } from '../../../__test-utils__/rm-sync-retry.js';
import { createWorktreeHandler } from './worktree.js';
import { defaultExecFile } from './worktree-managed.js';
import { worktreeTool } from '../schemas.worktree-tools.js';

const signal = new AbortController().signal;
let root: string;
let repo: string;
let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await defaultExecFile('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-worktree-repo-')));
  repo = join(root, 'repo');
  scratch = join(root, 'scratch');
  await fs.mkdir(repo);
  await fs.mkdir(scratch);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'AFK Test');
  await git(repo, 'config', 'user.email', 'test@afk.test');
  await fs.writeFile(join(repo, '.gitignore'), '.afk-worktrees/\n.afk-worktree-meta.json\n');
  await git(repo, 'add', '.gitignore');
  await git(repo, '-c', 'core.hooksPath=', 'commit', '-m', 'initial');
});

afterEach(() => {
  if (root) rmSyncRetry(root);
});

describe('worktree explicit repo (#3755)', () => {
  it('exposes repo as an optional schema parameter', () => {
    expect(worktreeTool.input_schema.properties).toHaveProperty('repo');
    expect(worktreeTool.input_schema.required).not.toContain('repo');
  });

  it('creates, lists, keeps, releases and removes in the selected repo from a non-git cwd', async () => {
    const handler = createWorktreeHandler(scratch);
    const created = await handler({ action: 'create', repo, name: 'feature', base: 'HEAD' }, signal,
      { resolveBase: scratch });
    expect(created.isError).not.toBe(true);
    const path = join(repo, '.afk-worktrees', 'feature');
    expect(JSON.parse(created.content)).toMatchObject({ path, branch: 'afk/feature' });
    expect(JSON.parse(await fs.readFile(join(path, '.afk-worktree-meta.json'), 'utf8')))
      .toMatchObject({ owner: 'agent' });
    const listed = await handler({ action: 'list', repo }, signal);
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse(listed.content)).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));

    const kept = await handler({ action: 'keep', repo, path: 'feature', reason: 'WIP' }, signal);
    expect(JSON.parse(kept.content)).toMatchObject({ path, locked: true });
    const lockedRemove = await handler({ action: 'remove', repo, path: 'feature', force: true }, signal);
    expect(lockedRemove.isError).toBe(true);
    expect(lockedRemove.content).toContain('locked');
    const released = await handler({ action: 'release', repo, path: 'feature' }, signal);
    expect(JSON.parse(released.content)).toMatchObject({ path, locked: false });
    const removed = await handler({ action: 'remove', repo, path: join('.afk-worktrees', 'feature') }, signal);
    expect(JSON.parse(removed.content)).toMatchObject({ path, removed: true });
    expect(await git(repo, 'rev-parse', '--verify', 'refs/heads/afk/feature')).not.toBe('');
    await expect(fs.stat(path)).rejects.toThrow();
  });

  it.each(['create', 'list', 'keep', 'release', 'remove'])('validates repo for %s', async (action) => {
    const handler = createWorktreeHandler(repo);
    for (const invalid of [null, 123, '', 'relative', `${repo}${sep}..${sep}repo`, `${repo}/../repo`, `${repo}\\..\\repo`]) {
      const result = await handler({ action, repo: invalid, name: 'bad', path: 'bad' }, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('repo must be an absolute path with no .. segments');
    }
    for (const invalid of [join(root, 'missing'), join(repo, '.gitignore'), scratch]) {
      const result = await handler({ action, repo: invalid, name: 'bad', path: 'bad' }, signal);
      expect(result.isError).toBe(true);
    }
    // No invalid explicit repo silently falls back to the valid session cwd.
    await expect(fs.stat(join(repo, '.afk-worktrees'))).rejects.toThrow();
  });

  it('preserves cwd defaults and supports repo subdirectories and linked worktrees', async () => {
    const handler = createWorktreeHandler(repo);
    const original = await handler({ action: 'create', name: 'from-cwd', base: 'HEAD' }, signal);
    expect(original.isError).not.toBe(true);
    const linked = join(repo, '.afk-worktrees', 'from-cwd');
    const subdir = join(linked, 'subdir');
    await fs.mkdir(subdir);
    const remoteHandler = createWorktreeHandler(scratch);
    const created = await remoteHandler({ action: 'create', repo: subdir, name: 'from-linked' }, signal);
    expect(created.isError).not.toBe(true);
    expect(JSON.parse(created.content)).toMatchObject({ path: join(repo, '.afk-worktrees', 'from-linked') });
    const listed = await remoteHandler({ action: 'list', repo: linked }, signal);
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse(listed.content)).toHaveLength(2);
  });

  it('keeps removal confined to the selected repo and refuses its main checkout', async () => {
    const handler = createWorktreeHandler(scratch);
    for (const path of [repo, scratch, '..', join('..', '..', 'repo')]) {
      const result = await handler({ action: 'remove', repo, path, force: true }, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('outside .afk-worktrees/');
    }
    expect(resolve(await git(repo, 'rev-parse', '--show-toplevel'))).toBe(resolve(repo));
  });

  it('retains dirty, ignored-local-state and commits-ahead removal guards with explicit repo', async () => {
    const handler = createWorktreeHandler(scratch);
    await handler({ action: 'create', repo, name: 'guarded', base: 'HEAD' }, signal);
    const path = join(repo, '.afk-worktrees', 'guarded');
    await fs.writeFile(join(path, 'local.txt'), 'local state');
    let result = await handler({ action: 'remove', repo, path: 'guarded' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('uncommitted changes');
    await git(path, 'add', 'local.txt');
    await git(path, '-c', 'core.hooksPath=', 'commit', '-m', 'ahead');
    result = await handler({ action: 'remove', repo, path: 'guarded' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ahead of its base');
    await fs.appendFile(join(repo, '.git', 'info', 'exclude'), '\n.env\n');
    await fs.writeFile(join(path, '.env'), 'local state');
    result = await handler({ action: 'remove', repo, path: 'guarded' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-rebuildable ignored files');
  });

  it('never tracks origin/main, even with branch.autoSetupMerge=always and push.default=upstream', async () => {
    const clone = join(root, 'clone');
    await git(root, 'clone', repo, clone);
    await git(clone, 'config', 'branch.autoSetupMerge', 'always');
    await git(clone, 'config', 'push.default', 'upstream');
    const handler = createWorktreeHandler(scratch);
    const result = await handler({ action: 'create', repo: clone, name: 'remote-base', base: 'origin/main' }, signal);
    expect(result.isError).not.toBe(true);
    const path = join(clone, '.afk-worktrees', 'remote-base');
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(await git(clone, 'rev-parse', 'origin/main'));
    expect(await git(clone, 'for-each-ref', '--format=%(upstream)', 'refs/heads/afk/remote-base')).toBe('');
    await expect(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).rejects.toThrow();
    // Dry-run only: an unqualified upstream push must refuse, not target main.
    await expect(git(path, '-c', 'push.autoSetupRemote=false', 'push', '--dry-run')).rejects.toThrow();
  });
});
