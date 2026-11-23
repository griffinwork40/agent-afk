/**
 * H4: `git_read` must never start a program named by repository-controlled
 * data. Every case builds a real repository in the OS temp dir, wires one
 * mechanism to a `node -e` command that writes a marker file, proves the
 * mechanism fires under the pre-H4 global options (control), then proves the
 * handler does not fire it and the read still succeeds.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSyncRetry } from '../../../__test-utils__/rm-sync-retry.js';
import { buildGitReadEnv, createGitReadHandler } from './git-read.js';
import { filterNeutralisingEnv, guardSubmoduleArgv, parseFilterDrivers } from './git-read.exec-guard.js';

/** The handler's global options before H4: the control proves each setup really executes. */
const PRE_H4_ARGS = [
  '--no-pager', '--no-optional-locks', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=',
  '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'gpg.program=false',
];
const signal = new AbortController().signal;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSyncRetry(d); });

const fwd = (p: string): string => p.split('\\').join('/');
const scratch = (tag: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `git-read-h4-${tag}-`)));
  dirs.push(d);
  return d;
};
/** Shell command (git runs config commands through sh) that writes `marker`, then passes stdin through. */
const markerCmd = (marker: string): string =>
  `"${fwd(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1],'x');process.stdin.pipe(process.stdout)" "${fwd(marker)}"`;
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo(tag: string): string {
  const r = scratch(tag);
  git(r, 'init', '-q');
  writeFileSync(join(r, 'a.txt'), 'hello\n');
  git(r, 'add', 'a.txt');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}
/** Make a tracked file stat-dirty without changing content, so status must re-hash it. */
function statDirty(file: string): void {
  const t = new Date(Date.now() + 5_000);
  utimesSync(file, t, t);
}
function rawRan(cwd: string, marker: string, argv: string[]): boolean {
  rmSync(marker, { force: true });
  try { execFileSync('git', [...PRE_H4_ARGS, ...argv], { cwd, stdio: 'ignore', env: buildGitReadEnv(undefined) }); } catch { /* exit code irrelevant */ }
  return existsSync(marker);
}
async function handlerRan(cwd: string, marker: string, input: Record<string, unknown>): Promise<{ ran: boolean; content: string; isError: boolean }> {
  rmSync(marker, { force: true });
  const r = await createGitReadHandler(cwd)(input, signal);
  return { ran: existsSync(marker), content: String(r.content), isError: r.isError === true };
}

const READS: { name: string; input: Record<string, unknown>; raw: string[] }[] = [
  { name: 'blame', input: { subcommand: 'blame', args: ['-s'], paths: ['a.txt'] }, raw: ['blame', '--no-textconv', '-s', '--', 'a.txt'] },
  { name: 'diff', input: { subcommand: 'diff' }, raw: ['diff', '--no-ext-diff', '--no-textconv', '--'] },
  { name: 'diff --stat', input: { subcommand: 'diff', args: ['--stat'] }, raw: ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--'] },
  { name: 'status', input: { subcommand: 'status', args: ['--porcelain'] }, raw: ['status', '--porcelain', '--'] },
];

async function expectClosed(repo: string, marker: string, cwd = repo): Promise<void> {
  const controls = READS.map((r) => rawRan(cwd, marker, r.raw));
  expect(controls.some(Boolean), 'control: setup must execute under pre-H4 args').toBe(true);
  for (const r of READS) {
    const out = await handlerRan(cwd, marker, r.input);
    expect(out.ran, `${r.name} ran a repository program`).toBe(false);
    expect(out.isError, `${r.name}: ${out.content}`).toBe(false);
  }
}

describe('git_read exec guard: filter drivers (real git)', () => {
  it('clean filter assigned by .gitattributes', async () => {
    const r = makeRepo('clean'); const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(r, '.gitattributes'), '* filter=x\n');
    appendFileSync(join(r, 'a.txt'), 'world\n');
    await expectClosed(r, m);
  });

  it('status of a stat-dirty file under a clean filter', async () => {
    const r = makeRepo('status'); const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(r, '.git', 'info', 'attributes'), 'a.txt filter=x\n');
    statDirty(join(r, 'a.txt'));
    expect(rawRan(r, m, ['status', '--porcelain'])).toBe(true);
    expect((await handlerRan(r, m, { subcommand: 'status', args: ['--porcelain'] })).ran).toBe(false);
  });

  it('long-running process filter marked required, plus smudge', async () => {
    const r = makeRepo('process'); const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.p.process', markerCmd(m));
    git(r, 'config', 'filter.p.smudge', markerCmd(m));
    git(r, 'config', 'filter.p.required', 'true');
    writeFileSync(join(r, '.gitattributes'), '* filter=p\n');
    appendFileSync(join(r, 'a.txt'), 'world\n');
    await expectClosed(r, m);
    const diff = await handlerRan(r, m, { subcommand: 'diff' });
    expect(diff.content).toContain('+world');
  });

  it.each([
    ['include.path', 'include.path'],
    ['includeIf', 'includeIf.gitdir:**.path'],
  ])('dotted driver name defined only through %s', async (_label, key) => {
    const r = makeRepo('include'); const m = `${r}.marker`; dirs.push(m);
    const inc = join(scratch('inc'), 'inc.cfg');
    const value = markerCmd(m).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    writeFileSync(inc, `[filter "we.i-rd.x"]\n\tclean = "${value}"\n`);
    git(r, 'config', key, fwd(inc));
    writeFileSync(join(r, '.gitattributes'), '* filter=we.i-rd.x\n');
    appendFileSync(join(r, 'a.txt'), 'world\n');
    await expectClosed(r, m);
  });

  it('attributes from core.attributesFile', async () => {
    const r = makeRepo('attrfile'); const m = `${r}.marker`; dirs.push(m);
    const attrs = join(scratch('attrs'), 'attributes');
    writeFileSync(attrs, '* filter=x\n');
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    git(r, 'config', 'core.attributesFile', fwd(attrs));
    appendFileSync(join(r, 'a.txt'), 'world\n');
    await expectClosed(r, m);
  });

  it('a .git file with a gitdir: pointer to a repository that defines the driver', async () => {
    const real = makeRepo('gitdir-real'); const m = `${real}.marker`; dirs.push(m);
    const wt = scratch('gitdir-wt');
    writeFileSync(join(wt, '.git'), `gitdir: ${fwd(join(real, '.git'))}\n`);
    git(wt, 'config', 'core.worktree', fwd(wt));
    git(wt, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(wt, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(wt, 'a.txt'), 'hello\nworld\n');
    await expectClosed(wt, m);
  });

  it('a directory that looks like a bare repository with core.worktree', async () => {
    const real = makeRepo('bare-src'); const m = `${real}.marker`; dirs.push(m);
    const bare = scratch('bare');
    cpSync(join(real, '.git'), bare, { recursive: true });
    git(bare, 'config', 'core.bare', 'false');
    git(bare, 'config', 'core.worktree', fwd(real));
    git(bare, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(real, '.gitattributes'), '* filter=x\n');
    appendFileSync(join(real, 'a.txt'), 'world\n');
    expect(rawRan(bare, m, ['diff', '--stat'])).toBe(true);
    for (const input of [{ subcommand: 'diff', args: ['--stat'] }, { subcommand: 'status' }]) {
      expect((await handlerRan(bare, m, input)).ran).toBe(false);
    }
  });
});

describe('git_read exec guard: hooks, diff drivers, submodules (real git)', () => {
  it('a post-index-change hook does not run on worktree diff', async () => {
    const r = makeRepo('hook'); const m = `${r}.marker`; dirs.push(m);
    const hook = join(r, '.git', 'hooks', 'post-index-change');
    mkdirSync(join(r, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\n${markerCmd(m)} </dev/null\n`);
    chmodSync(hook, 0o755);
    statDirty(join(r, 'a.txt'));
    expect(rawRan(r, m, ['diff', '--stat'])).toBe(true);
    statDirty(join(r, 'a.txt'));
    expect((await handlerRan(r, m, { subcommand: 'diff', args: ['--stat'] })).ran).toBe(false);
  });

  it('textconv and per-attribute diff commands stay off (policy forces --no-textconv / --no-ext-diff)', async () => {
    const r = makeRepo('textconv'); const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'diff.t.textconv', markerCmd(m));
    git(r, 'config', 'diff.t.command', markerCmd(m));
    writeFileSync(join(r, '.gitattributes'), '* diff=t\n');
    git(r, 'add', '.gitattributes'); git(r, 'commit', '-q', '-m', 'attrs');
    appendFileSync(join(r, 'a.txt'), 'world\n');
    expect(rawRan(r, m, ['blame', '-s', '--', 'a.txt'])).toBe(true); // blame applies textconv by default
    for (const input of [...READS.map((x) => x.input), { subcommand: 'log', args: ['-p'] }, { subcommand: 'show', args: ['HEAD'] }, { subcommand: 'grep', pattern: 'hello' }]) {
      expect((await handlerRan(r, m, input)).ran, JSON.stringify(input)).toBe(false);
    }
  });

  it('a dirty submodule with its own filter and diff driver is not entered', async () => {
    const sub = makeRepo('sub'); const sup = makeRepo('sup'); const m = `${sup}.marker`; dirs.push(m);
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', fwd(sub), 'sm');
    git(sup, 'commit', '-q', '-m', 'sm');
    const smDir = join(sup, 'sm');
    git(smDir, 'config', 'filter.y.clean', markerCmd(m));
    git(smDir, 'config', 'diff.t.command', markerCmd(m));
    writeFileSync(join(smDir, '.gitattributes'), '* filter=y diff=t\n');
    git(smDir, 'add', '.gitattributes'); git(smDir, 'commit', '-q', '-m', 'attrs');
    git(sup, 'add', 'sm'); git(sup, 'commit', '-q', '-m', 'bump');
    git(sup, 'config', 'diff.submodule', 'diff');
    appendFileSync(join(smDir, 'a.txt'), 'world\n');
    await expectClosed(sup, m);
    for (const input of [{ subcommand: 'log', args: ['-p', '--max-count=1'] }, { subcommand: 'show', args: ['HEAD'] }]) {
      const out = await handlerRan(sup, m, input);
      expect(out.ran, JSON.stringify(input)).toBe(false);
      expect(out.content).toContain('Subproject commit');
    }
  });
});

describe('git_read exec guard: LFS-style configuration and fail-closed', () => {
  it('an LFS-style required driver is neutralised: content is shown raw, the read succeeds', async () => {
    const r = makeRepo('lfs'); const m = `${r}.marker`; dirs.push(m);
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n';
    writeFileSync(join(r, 'big.bin'), pointer);
    git(r, 'add', 'big.bin'); git(r, 'commit', '-q', '-m', 'pointer');
    git(r, 'config', 'filter.lfs.clean', markerCmd(m));
    git(r, 'config', 'filter.lfs.smudge', markerCmd(m));
    git(r, 'config', 'filter.lfs.process', markerCmd(m));
    git(r, 'config', 'filter.lfs.required', 'true');
    writeFileSync(join(r, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(r, 'big.bin'), 'real-content\n');
    const diff = await handlerRan(r, m, { subcommand: 'diff', paths: ['big.bin'] });
    expect(diff.ran).toBe(false);
    expect(diff.content).toContain('-version https://git-lfs.github.com/spec/v1');
    expect(diff.content).toContain('+real-content');
    const status = await handlerRan(r, m, { subcommand: 'status', args: ['--porcelain'] });
    expect(status.ran).toBe(false);
    expect(status.content).toContain(' M big.bin');
  });

  it('refuses the read when the driver enumeration fails', async () => {
    const r = makeRepo('badcfg'); const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(r, '.gitattributes'), '* filter=x\n');
    appendFileSync(join(r, 'a.txt'), 'world\n');
    appendFileSync(join(r, '.git', 'config'), '[broken\n');
    const out = await handlerRan(r, m, { subcommand: 'blame', paths: ['a.txt'] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('refused');
    expect(out.ran).toBe(false);
  });

  it('parseFilterDrivers fails closed on unparseable output and keeps exotic names', () => {
    expect(parseFilterDrivers('')).toEqual({ ok: true, names: [] });
    expect(parseFilterDrivers('filter.a b.c.clean\0filter.lfs.required\0filter.x.other\0filter.plain\0'))
      .toEqual({ ok: true, names: ['a b.c', 'lfs'] });
    expect(parseFilterDrivers('filter.x.clean').ok).toBe(false);
    expect(parseFilterDrivers('core.pager\0').ok).toBe(false);
    expect(parseFilterDrivers('filter.x.Clean\0').ok).toBe(false);
    expect(parseFilterDrivers(Array.from({ length: 300 }, (_, i) => `filter.d${i}.clean\0`).join('')).ok).toBe(false);
  });

  it('builds a GIT_CONFIG_COUNT override per driver and inserts --ignore-submodules=dirty', () => {
    expect(filterNeutralisingEnv([])).toEqual({});
    const env = filterNeutralisingEnv(['x']);
    expect(env['GIT_CONFIG_COUNT']).toBe('4');
    expect(env['GIT_CONFIG_KEY_3']).toBe('filter.x.required');
    expect(env['GIT_CONFIG_VALUE_3']).toBe('false');
    expect(env['GIT_CONFIG_VALUE_0']).toBe('');
    expect(guardSubmoduleArgv(['diff', '--stat'])).toEqual(['diff', '--ignore-submodules=dirty', '--stat']);
    expect(guardSubmoduleArgv(['log', '-p'])).toEqual(['log', '-p']);
  });
});
