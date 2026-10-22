import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, rmSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorkspaceTree, diffTrees, type CaptureResult } from './git-snapshot.js';
import { _setAttrSourceSupportForTests, hasConvertingAttribute } from './git-snapshot.attrs.js';
import { _setMaxBlobBytesForTests, parseBatchCheck, parseCatFileBatch, parseRawDiff, toAbsPath } from './git-snapshot.diff.js';
import { quoteAlternate } from './git-snapshot.exec.js';
import { hasFlaggedEntries } from './git-snapshot.index.js';

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
afterEach(async () => {
  _setAttrSourceSupportForTests(undefined);
  _setMaxBlobBytesForTests(undefined);
  await fs.chmod(tmp, 0o700).catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

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

  it('diffTrees creates private hooks directory next to objectDir even when capture has not run', async () => {
    await initRepo();
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
    // Use a fresh private store without calling captureWorkspaceTree first.
    const freshObjectDir = path.join(tmp, 'fresh-priv', 'objects');
    const expectedHooksDir = path.join(path.dirname(freshObjectDir), `${path.basename(freshObjectDir)}-hooks`);
    expect(existsSync(expectedHooksDir)).toBe(false);
    const result = await diffTrees({ repoRoot: realRepo(), objectDir: freshObjectDir, before: tree, after: tree, maxFiles: 10, timeoutMs: 20_000 });
    expect(result.ok).toBe(true);
    expect(existsSync(expectedHooksDir)).toBe(true);
  });
});

describe('review hardening (real git)', () => {
  it('never runs the user repo post-index-change hook', async () => {
    await initRepo();
    const marker = path.join(tmp, 'hook-ran');
    const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, `#!/bin/sh\necho ran >> "${marker.split(path.sep).join('/')}"\n`, { mode: 0o755 });
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'mod.txt'), 'after\n');
    await captureOk();
    expect(before.tree).toMatch(/^[0-9a-f]+$/);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports partial when add cannot read a file (where chmod makes it unreadable)', async () => {
    await initRepo();
    const locked = path.join(repo, 'secret.txt');
    await fs.writeFile(locked, 'hidden\n');
    await fs.chmod(locked, 0o000);
    let unreadable = true;
    try { readFileSync(locked); unreadable = false; } catch { /* expected */ }
    const r = await capture();
    await fs.chmod(locked, 0o600);
    if (!r.ok) throw new Error(`capture failed: ${r.reason} ${r.detail ?? ''}`);
    if (unreadable) expect(r.partial).toMatch(/could not be read/);
    else expect(r.partial).toBeUndefined();
  });

  it('puts an oversized prior blob in skipped without reading it', async () => {
    await initRepo();
    await fs.writeFile(path.join(repo, 'big.bin'), Buffer.alloc(4096, 7));
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'big.bin'), 'small');
    await fs.writeFile(path.join(repo, 'mod.txt'), 'after\n');
    const after = await captureOk();
    _setMaxBlobBytesForTests(1024);
    const d = await diff(before.tree, after.tree);
    expect(d.changes.map((c) => rel(c.absPath))).toEqual(['mod.txt']);
    expect(d.changes[0]?.prior?.bytes.toString()).toBe('before\n');
    expect(d.skipped).toEqual([{ absPath: path.join(realRepo(), 'big.bin'), reason: expect.stringContaining('larger than 1024') }]);
  });

  it('works when the repo path contains the alternates separator (where creatable)', async () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    repo = path.join(tmp, `re${sep}po "q"`);
    try { await fs.mkdir(repo); } catch { return; }
    await initRepo(false);
    // Backdate before committing so the seeded entries are not racy: `add`
    // then reuses their blobs, which live only in the user store (the alternate).
    const past = new Date(Date.now() - 3_600_000);
    for (const f of ['keep.txt', 'mod.txt', 'del.txt']) await fs.utimes(path.join(repo, f), past, past);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    const before = await captureOk();
    expect(listFiles(priv.objectDir).some((f) => /^[0-9a-f]{2}[/\\][0-9a-f]+$/.test(f))).toBe(false);
    await fs.writeFile(path.join(repo, 'mod.txt'), 'after\n');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    expect(d.changes.map((c) => [rel(c.absPath), c.prior?.bytes.toString()])).toEqual([['mod.txt', 'before\n']]);
  });

  it('refuses unsafe-attributes on git without --attr-source when a nested .gitattributes filters', async () => {
    await initRepo();
    _setAttrSourceSupportForTests(false);
    await fs.mkdir(path.join(repo, 'assets'));
    await fs.writeFile(path.join(repo, 'assets', '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    expect(await capture()).toMatchObject({ ok: false, reason: 'unsafe-attributes' });
  });

  it('captures normally on git without --attr-source when no attribute converts', async () => {
    await initRepo();
    _setAttrSourceSupportForTests(false);
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.lock -merge linguist-generated\n');
    const before = await captureOk();
    await fs.writeFile(path.join(repo, 'mod.txt'), 'after\n');
    const after = await captureOk();
    expect((await diff(before.tree, after.tree)).changes.map((c) => rel(c.absPath))).toEqual(['mod.txt']);
  });

  it('refuses when info/attributes converts, even with --attr-source', async () => {
    await initRepo();
    _setAttrSourceSupportForTests(true);
    const info = git(repo, 'rev-parse', '--git-path', 'info/attributes').trim();
    await fs.mkdir(path.dirname(path.resolve(repo, info)), { recursive: true });
    await fs.writeFile(path.resolve(repo, info), '* eol=crlf\n');
    expect(await capture()).toMatchObject({ ok: false, reason: 'unsafe-attributes' });
  });

  it('keeps CRLF bytes exactly under * text=auto when --attr-source is supported', async () => {
    await initRepo();
    _setAttrSourceSupportForTests(undefined);
    await fs.writeFile(path.join(repo, '.gitattributes'), '* text=auto\n');
    await fs.writeFile(path.join(repo, 'crlf.txt'), 'x\r\ny\r\n');
    const before = await capture();
    // A git without --attr-source refuses rather than storing converted bytes.
    if (!before.ok) { expect(before.reason).toBe('unsafe-attributes'); return; }
    await fs.writeFile(path.join(repo, 'crlf.txt'), 'z\n');
    const after = await captureOk();
    const d = await diff(before.tree, after.tree);
    expect(d.changes.find((c) => rel(c.absPath) === 'crlf.txt')?.prior?.bytes.toString('latin1')).toBe('x\r\ny\r\n');
  });

  it('does not seed from a repo index with a skip-worktree entry', async () => {
    await initRepo();
    git(repo, 'update-index', '--skip-worktree', 'mod.txt');
    await fs.writeFile(path.join(repo, 'mod.txt'), 'hidden local edit\n');
    const before = await captureOk();
    // Seeded, the skip-worktree entry would keep the committed blob ('before').
    const objEnv = { ...GIT_ENV, GIT_OBJECT_DIRECTORY: priv.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git', 'objects') };
    const shown = execFileSync('git', ['cat-file', '-p', `${before.tree}:mod.txt`], { cwd: repo, env: objEnv, encoding: 'utf8' });
    expect(shown).toBe('hidden local edit\n');
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

  it('parseBatchCheck reads sizes and fails closed on a missing object', () => {
    expect(parseBatchCheck(Buffer.from(`${'a'.repeat(40)} blob 12\n${'b'.repeat(40)} blob 0\n`), 2)).toEqual([12, 0]);
    expect(parseBatchCheck(Buffer.from(`${'a'.repeat(40)} missing\n`), 1)).toBeNull();
  });

  it('quoteAlternate C-quotes only paths with the separator or a quote', () => {
    expect(quoteAlternate('/a/b', ':')).toBe('/a/b');
    expect(quoteAlternate('/a:b', ':')).toBe('"/a:b"');
    expect(quoteAlternate('/a"b\\c', ':')).toBe('"/a\\"b\\\\c"');
    expect(quoteAlternate('/é:x\n', ':')).toBe('"/é:x\\012"');
  });

  it('hasConvertingAttribute matches every form, not substrings', () => {
    for (const t of ['* filter=lfs', '*.c -text', '* !eol', 'x crlf', '[attr]bin -diff -text', '"a b" ident', 'f working-tree-encoding=UTF-16']) {
      expect(hasConvertingAttribute(t)).toBe(true);
    }
    for (const t of ['# * text', '*.lock -merge', 'context.txt diff', 'textfile linguist-generated', '']) {
      expect(hasConvertingAttribute(t)).toBe(false);
    }
  });

  it('hasFlaggedEntries spots assume-unchanged and skip-worktree tags', () => {
    expect(hasFlaggedEntries(Buffer.from('H a\0H b\0'))).toBe(false);
    expect(hasFlaggedEntries(Buffer.from('H a\0S b\0'))).toBe(true);
    expect(hasFlaggedEntries(Buffer.from('h a\0'))).toBe(true);
  });
});
