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
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  AFK_META_EXCLUDE_PATTERN,
  AFK_SCRATCH_EXCLUDE_PATTERN,
  ensureAfkExcludes,
  excludeHasMetaEntry,
  excludeHasScratchEntry,
  missingAfkExcludes,
} from './worktree-scratch.js';
import { createManagedWorktree, removeManagedWorktreeGuarded, teardownIsolatedWorktree } from '../tools/handlers/worktree-managed.js';
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
  // Match by slug, not by full path: on Windows git prints forward slashes
  // (and may print the long form of an 8.3 temp path), so a `startsWith` on
  // the backslashed `wt` never finds the block.
  const suffix = `/${basename(wt)}`;
  const block = list
    .split(/\r?\n\r?\n/)
    .find((b) => (b.split(/\r?\n/)[0] ?? '').replace(/\\/g, '/').endsWith(suffix));
  return block?.split(/\r?\n/).some((l) => l.startsWith('locked')) ?? false;
}

beforeEach(async () => {
  repo = await initRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('ensureAfkExcludes', () => {
  it('appends the anchored pattern once (idempotent) and keeps prior content', async () => {
    await fs.writeFile(join(repo, '.git', 'info', 'exclude'), '# existing\nfoo/');
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const content = await readExclude();
    expect(content.startsWith('# existing\nfoo/\n')).toBe(true);
    expect(content.split('\n').filter((l) => l === AFK_SCRATCH_EXCLUDE_PATTERN)).toHaveLength(1);
    expect(content.split('\n').filter((l) => l === AFK_META_EXCLUDE_PATTERN)).toHaveLength(1);
  });

  it('adds only the missing entry when one is already present', async () => {
    await fs.writeFile(join(repo, '.git', 'info', 'exclude'), `${AFK_SCRATCH_EXCLUDE_PATTERN}\n`);
    expect(missingAfkExcludes(await readExclude())).toEqual([AFK_META_EXCLUDE_PATTERN]);
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const content = await readExclude();
    expect(content.split('\n').filter((l) => l === AFK_SCRATCH_EXCLUDE_PATTERN)).toHaveLength(1);
    expect(excludeHasMetaEntry(content)).toBe(true);
  });

  it('creates a missing info directory and exclude file', async () => {
    await fs.rm(join(repo, '.git', 'info'), { recursive: true });
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    expect(excludeHasScratchEntry(await readExclude())).toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(join(repo, '.git', 'info', 'exclude'))).mode & 0o777).toBe(0o644);
    }
  });

  it('preserves a different writer’s append between the read and write', async () => {
    const excludePath = join(repo, '.git', 'info', 'exclude');
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => {
      const snapshot = await readFile(excludePath, 'utf-8');
      await fs.appendFile(excludePath, '\nother-writer/\n');
      return snapshot;
    });
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const content = await readExclude();
    expect(content).toContain('\nother-writer/\n');
    expect(excludeHasScratchEntry(content)).toBe(true);
  });

  it('keeps a no-trailing-newline append from another writer on its own line', async () => {
    const excludePath = join(repo, '.git', 'info', 'exclude');
    await fs.writeFile(excludePath, '# existing\n');
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => {
      const snapshot = await readFile(excludePath, 'utf-8');
      await fs.appendFile(excludePath, 'other-writer/');
      return snapshot;
    });
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const lines = (await readExclude()).split('\n');
    expect(lines).toContain('other-writer/');
    expect(lines).toContain(AFK_SCRATCH_EXCLUDE_PATTERN);
    expect(lines).toContain(AFK_META_EXCLUDE_PATTERN);
  });

  it('writes to the SHARED common dir when called from a linked worktree', async () => {
    const wt = join(repo, '.afk-worktrees', 'linked');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/linked', wt]);
    expect(await ensureAfkExcludes(execFile, wt)).toBe(true);
    expect(excludeHasScratchEntry(await readExclude())).toBe(true);
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'PR_BODY.md'), 'body');
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('fails safe: returns false (never throws) outside a git repo', async () => {
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-scratch-nogit-')));
    try {
      expect(await ensureAfkExcludes(execFile, notRepo)).toBe(false);
      expect(existsSync(join(notRepo, 'info'))).toBe(false);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('fails safe when the git runner throws', async () => {
    const throwing = (async () => { throw new Error('git missing'); }) as ExecFileFn;
    expect(await ensureAfkExcludes(throwing, repo)).toBe(false);
  });

  it('recognises an existing unanchored entry as already present', () => {
    expect(excludeHasScratchEntry('.afk-scratch/\n')).toBe(true);
    expect(excludeHasScratchEntry('# .afk-scratch/\n')).toBe(false);
    expect(excludeHasMetaEntry('.afk-worktree-meta.json\r\n')).toBe(true);
    expect(excludeHasMetaEntry('# .afk-worktree-meta.json\n')).toBe(false);
  });

  // Item 1: CRLF line endings throughout the exclude file.
  it('missingAfkExcludes returns empty when both entries are present in a CRLF file', () => {
    const crlf = `# git's default exclude file\r\n${AFK_SCRATCH_EXCLUDE_PATTERN}\r\n${AFK_META_EXCLUDE_PATTERN}\r\n`;
    expect(missingAfkExcludes(crlf)).toEqual([]);
  });

  it('missingAfkExcludes finds both missing entries in a CRLF file that has neither', () => {
    const crlf = '# comment\r\nfoo/\r\nbar/\r\n';
    expect(missingAfkExcludes(crlf)).toContain(AFK_SCRATCH_EXCLUDE_PATTERN);
    expect(missingAfkExcludes(crlf)).toContain(AFK_META_EXCLUDE_PATTERN);
  });

  it('ensureAfkExcludes appends missing entries exactly once into a CRLF-formatted file', async () => {
    // Write an exclude file that uses Windows line endings throughout.
    const crlfContent = `# git default\r\nfoo/\r\n`;
    await fs.writeFile(join(repo, '.git', 'info', 'exclude'), crlfContent);
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const content = await readExclude();
    // Idempotent: calling again must not duplicate.
    expect(await ensureAfkExcludes(execFile, repo)).toBe(true);
    const content2 = await readExclude();
    expect(content2.split('\n').filter((l) => l.trimEnd() === AFK_SCRATCH_EXCLUDE_PATTERN)).toHaveLength(1);
    expect(content2.split('\n').filter((l) => l.trimEnd() === AFK_META_EXCLUDE_PATTERN)).toHaveLength(1);
    // Original CRLF content is preserved.
    expect(content).toContain('foo/');
    expect(content2).toContain('foo/');
  });

  it('recognises both entries when they appear on CRLF lines (anchored and unanchored)', () => {
    // Both the anchored pattern and the unanchored spelling must be detected.
    expect(excludeHasScratchEntry(`${AFK_SCRATCH_EXCLUDE_PATTERN}\r\n`)).toBe(true);
    expect(excludeHasScratchEntry(`.afk-scratch/\r\n`)).toBe(true);
    expect(excludeHasMetaEntry(`${AFK_META_EXCLUDE_PATTERN}\r\n`)).toBe(true);
    expect(excludeHasMetaEntry(`.afk-worktree-meta.json\r\n`)).toBe(true);
  });
});

describe('teardown in a repo that does NOT gitignore the meta file', () => {
  /** Drop the meta line from the tracked .gitignore, as most consumer repos have it. */
  async function ungitignoreMeta(): Promise<void> {
    await fs.writeFile(join(repo, '.gitignore'), '.afk-worktrees/\n*.local.txt\n');
    await git(repo, ['commit', '-q', '-am', 'no meta ignore']);
  }

  it('a fresh managed tree reads clean and is removed, not locked', async () => {
    await ungitignoreMeta();
    const wt = await makeManagedTree('meta-only');
    expect(existsSync(join(wt, '.afk-worktree-meta.json'))).toBe(true);
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('a tree created BEFORE the exclude existed is removed too (re-ensured at teardown)', async () => {
    await ungitignoreMeta();
    const wt = join(repo, '.afk-worktrees', 'legacy-meta');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/legacy-meta', wt]);
    await fs.writeFile(join(wt, '.afk-worktree-meta.json'), '{"owner":"agent"}');
    expect(await git(wt, ['status', '--porcelain'])).toBe('?? .afk-worktree-meta.json');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result.removed).toBe(true);
  });

  it('real work next to the meta file still preserves and locks', async () => {
    await ungitignoreMeta();
    const wt = await makeManagedTree('meta-and-work');
    await fs.writeFile(join(wt, 'notes.md'), 'real work');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });
    expect(await isLocked(wt)).toBe(true);
  });
});

describe('isolated-worktree teardown with .afk-scratch/', () => {
  it('createManagedWorktree ensures the exclude entry', async () => {
    const wt = await makeManagedTree('create');
    expect(excludeHasScratchEntry(await readExclude())).toBe(true);
    expect(excludeHasMetaEntry(await readExclude())).toBe(true);
    const meta = JSON.parse(await fs.readFile(join(wt, '.afk-worktree-meta.json'), 'utf-8'));
    expect(meta.scratchDisposable).toBe(true);
  });

  it('a tree whose only extra content is .afk-scratch/ files is removed, not locked', async () => {
    const wt = await makeManagedTree('scratch-only');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'COMMIT_BODY.txt'), 'msg');
    // Gitignored by the repo AND inside scratch: still disposable, no ignored-local-state.
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.local.txt'), 'x');
    await fs.writeFile(join(wt, '.afk-scratch', 'prod.env'), 'disposable');
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(existsSync(wt)).toBe(false);
  });

  it.each([false, true])('preserves a plain tree without opt-in (shared exclude already present: %s)', async (excluded) => {
    const wt = join(repo, '.afk-worktrees', 'legacy');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/legacy', wt]);
    if (excluded) await makeManagedTree('other-opted-in');
    expect(excludeHasScratchEntry(await readExclude())).toBe(excluded);
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.md'), 'keep');
    const result = await removeManagedWorktreeGuarded({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toMatchObject({ removed: false, reason: 'ignored-local-state', detail: '.afk-scratch/' });
    expect(await fs.readFile(join(wt, '.afk-scratch', 'notes.md'), 'utf-8')).toBe('keep');
  });

  it.each(['{}', '{', 'null', '[]', '{"scratchDisposable":"true"}', '{"scratchDisposable":false}'])(
    'protects scratch with absent or invalid opt-in metadata: %s', async (meta) => {
      const wt = await makeManagedTree('invalid-meta');
      await fs.writeFile(join(wt, '.afk-worktree-meta.json'), meta);
      await fs.mkdir(join(wt, '.afk-scratch'));
      await fs.writeFile(join(wt, '.afk-scratch', 'notes.md'), 'keep');
      expect(await removeManagedWorktreeGuarded({ execFile, repoRoot: repo, worktreePath: wt }))
        .toMatchObject({ removed: false, reason: 'ignored-local-state' });
      expect(existsSync(join(wt, '.afk-scratch', 'notes.md'))).toBe(true);
    },
  );

  it('protects scratch when metadata is unreadable as a file', async () => {
    const wt = await makeManagedTree('unreadable-meta');
    await fs.unlink(join(wt, '.afk-worktree-meta.json'));
    await fs.mkdir(join(wt, '.afk-worktree-meta.json'));
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.md'), 'keep');
    expect(await removeManagedWorktreeGuarded({ execFile, repoRoot: repo, worktreePath: wt }))
      .toMatchObject({ removed: false, reason: 'ignored-local-state' });
    expect(existsSync(join(wt, '.afk-scratch', 'notes.md'))).toBe(true);
  });

  it('retries exclusion for an opted-in tree when the creation-time entry is lost', async () => {
    const wt = await makeManagedTree('retry');
    await fs.writeFile(join(repo, '.git', 'info', 'exclude'), '# reset\n');
    await fs.mkdir(join(wt, '.afk-scratch'));
    await fs.writeFile(join(wt, '.afk-scratch', 'pr-body.txt'), 'b');
    expect(await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt }))
      .toEqual({ removed: true, preserved: false });
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

  // Item 2: a tracked `.afk-scratch/` directory in an opted-in worktree.
  //
  // When `.afk-scratch/` is committed (tracked) and the shared exclude is in
  // place, new files added inside it are IGNORED by git (reported as `!!`
  // lines, not `??`). The probe skips `!!` lines that start with `.afk-scratch/`
  // for opted-in trees (worktree-ignored-probe.ts:217), so an opted-in tree
  // with only new ignored files inside the tracked dir is REMOVED — same as
  // the untracked-scratch case. Modified TRACKED files inside the dir still
  // appear in `git status --porcelain` as ` M`, making the tree dirty and
  // preserved regardless of opt-in.
  it('opted-in: new ignored files inside a tracked .afk-scratch/ are skipped, tree is removed', async () => {
    // Commit .afk-scratch/ into the main repo so the worktree branch starts
    // with a tracked scratch dir and no commits-ahead offset.
    await fs.mkdir(join(repo, '.afk-scratch'));
    await fs.writeFile(join(repo, '.afk-scratch', '.keep'), '');
    // The shared exclude isn't set yet (no managed tree exists), so add freely.
    await git(repo, ['add', '.afk-scratch/.keep']);
    await git(repo, ['commit', '-q', '-m', 'track scratch dir in base']);
    const wt = await makeManagedTree('tracked-scratch-ignored-files');
    // The managed tree now starts with a committed .afk-scratch/ and the
    // shared exclude is in place. New files inside are ignored by git.
    await fs.writeFile(join(wt, '.afk-scratch', 'pr-body.txt'), 'disposable');
    // Confirm git sees the new file as ignored, not untracked.
    const statusOut = await git(wt, ['status', '--porcelain', '--ignored']);
    expect(statusOut).toContain('!! .afk-scratch/pr-body.txt');
    // For the opted-in tree the probe skips it → removed.
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: true, preserved: false });
    expect(existsSync(wt)).toBe(false);
  });

  it('a modified tracked file inside .afk-scratch/ preserves the tree (dirty path, not ignored probe)', async () => {
    // Same base setup: .afk-scratch/ is tracked in the repo.
    await fs.mkdir(join(repo, '.afk-scratch'), { recursive: true });
    await fs.writeFile(join(repo, '.afk-scratch', 'notes.md'), 'original');
    await git(repo, ['add', '.afk-scratch/notes.md']);
    await git(repo, ['commit', '-q', '-m', 'track scratch file in base']);
    const wt = await makeManagedTree('tracked-scratch-modified');
    // Modify the tracked file — git reports it as dirty. The exact XY code
    // depends on whether the base commit is an ancestor of the worktree HEAD
    // (` M` = worktree-modified, `M ` = staged); either way the line contains M.
    await fs.writeFile(join(wt, '.afk-scratch', 'notes.md'), 'edited — keep this');
    const statusOut = await git(wt, ['status', '--porcelain']);
    expect(statusOut).toMatch(/M/);
    const result = await teardownIsolatedWorktree({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toEqual({ removed: false, preserved: true, reason: 'dirty' });
    expect(await fs.readFile(join(wt, '.afk-scratch', 'notes.md'), 'utf-8')).toBe('edited — keep this');
  });

  it('non-opted-in: new ignored files inside a tracked .afk-scratch/ still protect the tree', async () => {
    // Same tracked setup, but the worktree has no scratchDisposable opt-in.
    await fs.mkdir(join(repo, '.afk-scratch'), { recursive: true });
    await fs.writeFile(join(repo, '.afk-scratch', '.keep'), '');
    await git(repo, ['add', '.afk-scratch/.keep']);
    await git(repo, ['commit', '-q', '-m', 'track scratch dir in base']);
    // Create a plain (non-managed) worktree: no opt-in meta.
    const wt = join(repo, '.afk-worktrees', 'tracked-scratch-no-optin');
    await git(repo, ['worktree', 'add', '-q', '-b', 'afk/tracked-scratch-no-optin', wt]);
    // Ensure the shared exclude is in place (simulates a sibling managed tree).
    await makeManagedTree('sibling-optin');
    // Now add a file inside the tracked .afk-scratch/ — it is ignored by git.
    await fs.writeFile(join(wt, '.afk-scratch', 'secret.md'), 'do not delete');
    const statusOut = await git(wt, ['status', '--porcelain', '--ignored']);
    expect(statusOut).toContain('!! .afk-scratch/secret.md');
    // Without opt-in the probe must NOT skip .afk-scratch/ → protected.
    const result = await removeManagedWorktreeGuarded({ execFile, repoRoot: repo, worktreePath: wt });
    expect(result).toMatchObject({ removed: false, reason: 'ignored-local-state' });
    expect(await fs.readFile(join(wt, '.afk-scratch', 'secret.md'), 'utf-8')).toBe('do not delete');
  });
});
