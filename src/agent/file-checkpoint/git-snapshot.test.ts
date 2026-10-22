import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, rmSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorkspaceTree, diffTrees, type CaptureResult } from './git-snapshot.js';
import { parseCatFileBatch, parseRawDiff, toAbsPath } from './git-snapshot.diff.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env: GIT_ENV, encoding: 'utf8',
  });
}

function gitConfigOr(cwd: string, key: string, fallback: string): string {
  try { return git(cwd, 'config', '--bool', key).trim(); } catch { return fallback; }
}

let tmp: string;
let repo: string;
let priv: { objectDir: string; indexFile: string };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'afk-git-snapshot-'));
  repo = path.join(tmp, 'repo');
  priv = { objectDir: path.join(tmp, 'priv', 'objects'), indexFile: path.join(tmp, 'priv', 'index') };
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function initRepo(commit = true): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  git(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, 'keep.txt'), 'keep\n');
  await fs.writeFile(path.join(repo, 'mod.txt'), 'before\n');
  await fs.writeFile(path.join(repo, 'del.txt'), 'doomed\n');
  if (commit) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
  }
}

async function capture(cwd = repo, timeoutMs = 20_000): Promise<CaptureResult> {
  return captureWorkspaceTree({ cwd, ...priv, timeoutMs });
}

async function captureOk(cwd = repo): Promise<{ repoRoot: string; tree: string }> {
  const r = await capture(cwd);
  if (!r.ok) throw new Error(`capture failed: ${r.reason} ${r.detail ?? ''}`);
  return r;
}

async function diff(before: string, after: string, maxFiles = 100) {
  const r = await diffTrees({ repoRoot: realRepo(), objectDir: priv.objectDir, before, after, maxFiles, timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`diff failed: ${r.reason} ${r.detail ?? ''}`);
  return r;
}

function realRepo(): string {
  return git(repo, 'rev-parse', '--show-toplevel').trim();
}

function rel(abs: string): string {
  return path.relative(realRepo(), abs).split(path.sep).join('/');
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('captureWorkspaceTree / diffTrees (real git)', () => {
  it('reports not-git outside a repository', async () => {
    const plain = path.join(tmp, 'plain');
    await fs.mkdir(plain);
    // GIT_CEILING_DIRECTORIES is stripped for the child, so guard against a
    // tmpdir that itself sits inside a repo by checking git's own answer.
    let insideRepo = true;
    try { git(plain, 'rev-parse', '--show-toplevel'); } catch { insideRepo = false; }
    const r = await capture(plain);
    if (insideRepo) expect(r.ok).toBe(true);
    else expect(r).toMatchObject({ ok: false, reason: 'not-git' });
  });

  it('captures created, modified and deleted files with exact prior bytes', async () => {
    await initRepo();
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'mod.txt'), 'after\n');
    await fs.rm(path.join(repo, 'del.txt'));
    await fs.writeFile(path.join(repo, 'new.txt'), 'brand new\n');
    const after = await captureOk();
    expect(after.repoRoot).toBe(realRepo());
    const d = await diff(before.tree, after.tree);
    const byPath = Object.fromEntries(d.changes.map((c) => [rel(c.absPath), c.prior]));
    expect(Object.keys(byPath).sort()).toEqual(['del.txt', 'mod.txt', 'new.txt']);
    expect(byPath['new.txt']).toBeNull();
    expect(byPath['mod.txt']?.bytes.toString()).toBe('before\n');
    expect(byPath['mod.txt']?.mode).toBe(0o644);
    expect(byPath['del.txt']?.bytes.toString()).toBe('doomed\n');
    expect(d.skipped).toEqual([]);
    expect(d.truncated).toBe(false);
  });

  it('includes untracked files and excludes .gitignored ones', async () => {
    await initRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.log\nbuild/\n');
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'u1\n');
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'u2\n');
    await fs.writeFile(path.join(repo, 'ignored.log'), 'noise\n');
    await fs.mkdir(path.join(repo, 'build'));
    await fs.writeFile(path.join(repo, 'build', 'out.js'), 'x');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    expect(d.changes.map((c) => rel(c.absPath))).toEqual(['untracked.txt']);
    expect(d.changes[0]?.prior?.bytes.toString()).toBe('u1\n');
  });

  it('round-trips exact binary bytes', async () => {
    await initRepo();
    const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256));
    bin[100] = 0; bin[101] = 0x0a; bin[102] = 0x0d;
    await fs.writeFile(path.join(repo, 'blob.bin'), bin);
    await fs.writeFile(path.join(repo, 'crlf.txt'), 'a\r\nb\r\n');
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from('replaced'));
    await fs.writeFile(path.join(repo, 'crlf.txt'), 'a\n');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    const byPath = Object.fromEntries(d.changes.map((c) => [rel(c.absPath), c.prior]));
    expect(byPath['blob.bin']?.bytes.equals(bin)).toBe(true);
    expect(byPath['crlf.txt']?.bytes.toString('latin1')).toBe('a\r\nb\r\n');
  });

  it('reports the exec bit as POSIX mode 0o755', async () => {
    await initRepo();
    await fs.writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    git(repo, 'add', 'run.sh');
    git(repo, 'update-index', '--chmod=+x', 'run.sh');
    git(repo, 'commit', '-qm', 'exec');
    await fs.chmod(path.join(repo, 'run.sh'), 0o755);
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'run.sh'), 'changed\n');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]?.prior?.mode).toBe(0o755);
  });

  it('skips symlink changes where symlinks can be created', async () => {
    await initRepo();
    const before = await captureOk();
    let created = true;
    try { await fs.symlink('keep.txt', path.join(repo, 'link')); } catch { created = false; }
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    // core.symlinks=false (some Windows setups) stores the link as a regular file.
    const symlinked = created && (await fs.lstat(path.join(repo, 'link'))).isSymbolicLink()
      && gitConfigOr(repo, 'core.symlinks', 'true') !== 'false';
    if (symlinked) {
      expect(d.changes).toEqual([]);
      expect(d.skipped).toEqual([{ absPath: path.join(realRepo(), 'link'), reason: 'symlink' }]);
    } else {
      expect(d.skipped.length + d.changes.length).toBe(created ? 1 : 0);
    }
  });

  it('truncates at maxFiles', async () => {
    await initRepo();
    const before = await captureOk();
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(repo, `f${i}.txt`), `${i}`);
    const after = await captureOk();
    const d = await diff(before.tree, after.tree, 3);
    expect(d.changes).toHaveLength(3);
    expect(d.truncated).toBe(true);
    const all = await diff(before.tree, after.tree, 5);
    expect(all.truncated).toBe(false);
  });

  it('captures the whole work tree from a nested cwd', async () => {
    await initRepo();
    const nested = path.join(repo, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'inner.txt'), 'in\n');
    const before = await captureOk(nested);
    expect(before.repoRoot).toBe(realRepo());
    await fs.writeFile(path.join(repo, 'mod.txt'), 'top-level change\n');
    await fs.writeFile(path.join(nested, 'inner.txt'), 'changed\n');
    const after = await captureOk(nested);
    const d = await diff(before.tree, after.tree);
    const paths = d.changes.map((c) => rel(c.absPath)).sort();
    expect(paths).toEqual(['a/b/inner.txt', 'mod.txt']);
    expect(d.changes.find((c) => rel(c.absPath) === 'a/b/inner.txt')?.absPath)
      .toBe(path.join(realRepo(), 'a', 'b', 'inner.txt'));
  });

  it('works in a repository with no commits', async () => {
    await initRepo(false);
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'mod.txt'), 'x\n');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    expect(d.changes.map((c) => [rel(c.absPath), c.prior?.bytes.toString()])).toEqual([['mod.txt', 'before\n']]);
  });

  it('leaves the user repository untouched', async () => {
    await initRepo();
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'u\n');
    const gitDir = path.join(repo, '.git');
    const indexPath = path.join(gitDir, 'index');
    const indexBytes = readFileSync(indexPath);
    const indexMtime = statSync(indexPath).mtimeMs;
    const objectsBefore = listFiles(path.join(gitDir, 'objects'));
    const refsBefore = listFiles(path.join(gitDir, 'refs'));
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'mod.txt'), 'changed\n');
    await fs.writeFile(path.join(repo, 'another.txt'), 'new\n');
    const after = await captureOk();
    await diff(before.tree, after.tree);
    expect(readFileSync(indexPath).equals(indexBytes)).toBe(true);
    expect(statSync(indexPath).mtimeMs).toBe(indexMtime);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
    expect(listFiles(path.join(gitDir, 'objects'))).toEqual(objectsBefore);
    expect(listFiles(path.join(gitDir, 'refs'))).toEqual(refsBefore);
    expect(git(repo, 'status', '--porcelain')).toContain('?? another.txt');
    expect(listFiles(priv.objectDir).length).toBeGreaterThan(0);
  });

  it('reuses the private index across captures (unchanged tree → same id)', async () => {
    await initRepo();
    const a = await captureOk();
    const b = await captureOk();
    expect(b.tree).toBe(a.tree);
    expect(existsSync(priv.indexFile)).toBe(true);
  });

  it('resolves timeout with a tiny budget and never throws', async () => {
    await initRepo();
    const r = await capture(repo, 1);
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    const d = await diffTrees({ repoRoot: repo, objectDir: priv.objectDir, before: 'a', after: 'b', maxFiles: 10, timeoutMs: 0 });
    expect(d).toMatchObject({ ok: false, reason: 'timeout' });
    // A later capture with a normal budget still works (no stale lock left behind).
    expect((await capture()).ok).toBe(true);
  });

  it('maps a bad tree id to error, not a throw', async () => {
    await initRepo();
    const d = await diffTrees({ repoRoot: repo, objectDir: priv.objectDir, before: 'deadbeef', after: 'cafebabe', maxFiles: 10, timeoutMs: 20_000 });
    expect(d).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('parsers', () => {
  it('parseRawDiff reads NUL-delimited raw records, including odd path bytes', () => {
    const z = '0'.repeat(40);
    const buf = Buffer.from(`:000000 100644 ${z} ${'a'.repeat(40)} A\0dir/new file\0:100755 000000 ${'b'.repeat(40)} ${z} D\0x\ny\0`);
    expect(parseRawDiff(buf)).toEqual([
      { oldMode: '000000', newMode: '100644', oldSha: z, status: 'A', gitPath: 'dir/new file' },
      { oldMode: '100755', newMode: '000000', oldSha: 'b'.repeat(40), status: 'D', gitPath: 'x\ny' },
    ]);
    expect(parseRawDiff(Buffer.from('garbage\0path\0'))).toBeNull();
  });

  it('parseCatFileBatch fails closed on a missing object', () => {
    const ok = Buffer.concat([Buffer.from(`${'a'.repeat(40)} blob 3\n`), Buffer.from('a\nb'), Buffer.from('\n')]);
    expect(parseCatFileBatch(ok, 1)?.[0]?.toString()).toBe('a\nb');
    expect(parseCatFileBatch(Buffer.from(`${'a'.repeat(40)} missing\n`), 1)).toBeNull();
  });

  it('toAbsPath uses platform separators', () => {
    expect(toAbsPath(path.join(os.tmpdir(), 'r'), 'a/b/c.txt')).toBe(path.join(os.tmpdir(), 'r', 'a', 'b', 'c.txt'));
  });
});
