/**
 * H6: the subagent checkpoint's `git status` must not run repository-
 * configured filter drivers. Each case builds a real repository in the OS
 * temp dir, wires a clean filter to a `node -e` marker command, proves the
 * filter fires under the pre-H6 global options (control), then proves that
 * `captureWorkspaceCheckpoint` does not fire it and still returns a valid
 * fingerprint.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { buildGitReadEnv } from '../tools/handlers/git-read.js';
import { enumerateFilterDrivers } from '../tools/handlers/git-read.exec-guard.js';
import { CHECKPOINT_GIT_GLOBAL_ARGS, captureWorkspaceCheckpoint, type CheckpointEnumDrivers, type CheckpointGitExec } from './continuation-guards.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSyncRetry(d); });

const fwd = (p: string): string => p.split('\\').join('/');
const scratch = (tag: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ckpt-h6-${tag}-`)));
  dirs.push(d);
  return d;
};

/** node -e command that writes a marker file, then passes stdin through. */
const markerCmd = (marker: string): string =>
  `"${fwd(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1],'x');process.stdin.pipe(process.stdout)" "${fwd(marker)}"`;

const gitSetup = ['-c', 'user.email=t@e', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath='];
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', [...gitSetup, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(tag: string): string {
  const r = scratch(tag);
  git(r, 'init', '-q');
  writeFileSync(join(r, 'a.txt'), 'hello\n');
  git(r, 'add', 'a.txt');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

/** Make a tracked file stat-dirty without changing content so `git status` must re-hash it via the clean filter. */
function statDirty(file: string): void {
  const t = new Date(Date.now() + 5_000);
  utimesSync(file, t, t);
}

/**
 * Control: prove the filter fires under CHECKPOINT_GIT_GLOBAL_ARGS alone
 * (i.e., without H6's filter-driver neutralisation).
 */
function controlRan(cwd: string, marker: string): boolean {
  rmSync(marker, { force: true });
  try {
    execFileSync('git', [...CHECKPOINT_GIT_GLOBAL_ARGS, 'status', '--porcelain=v1', '-z'], {
      cwd, encoding: 'utf8', stdio: 'ignore', env: buildGitReadEnv(undefined),
    });
  } catch { /* exit code irrelevant */ }
  return existsSync(marker);
}

describe('checkpoint filter guard (real git, H6)', () => {
  it('a clean filter assigned by .gitattributes does not run during checkpoint capture', async () => {
    const r = makeRepo('clean');
    const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(r, '.gitattributes'), '* filter=x\n');
    statDirty(join(r, 'a.txt'));

    expect(controlRan(r, m), 'control: filter must fire without H6 guard').toBe(true);

    // Clear the marker left by the control run, then re-dirty and checkpoint.
    rmSync(m, { force: true });
    statDirty(join(r, 'a.txt'));
    const cp = await captureWorkspaceCheckpoint(r);
    expect(existsSync(m), 'checkpoint must not fire the clean filter').toBe(false);
    expect(cp.git).toBe(true);
    expect(cp.unavailable).toBeUndefined();
    expect(cp.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a required LFS-style filter does not run; checkpoint still returns a fingerprint', async () => {
    const r = makeRepo('lfs');
    const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.lfs.clean', markerCmd(m));
    git(r, 'config', 'filter.lfs.smudge', markerCmd(m));
    git(r, 'config', 'filter.lfs.process', markerCmd(m));
    git(r, 'config', 'filter.lfs.required', 'true');
    writeFileSync(join(r, '.gitattributes'), '*.txt filter=lfs\n');
    statDirty(join(r, 'a.txt'));

    expect(controlRan(r, m), 'control: required filter must fire without H6 guard').toBe(true);

    // Clear the marker left by the control run, then re-dirty and checkpoint.
    rmSync(m, { force: true });
    statDirty(join(r, 'a.txt'));
    const cp = await captureWorkspaceCheckpoint(r);
    expect(existsSync(m), 'checkpoint must not fire the required filter').toBe(false);
    expect(cp.git).toBe(true);
    expect(cp.unavailable).toBeUndefined();
    expect(cp.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a broken repository config: filter never fires and checkpoint is safe (git:false or unavailable)', async () => {
    const r = makeRepo('badcfg');
    const m = `${r}.marker`; dirs.push(m);
    git(r, 'config', 'filter.x.clean', markerCmd(m));
    writeFileSync(join(r, '.gitattributes'), '* filter=x\n');
    appendFileSync(join(r, '.git', 'config'), '[broken\n');
    statDirty(join(r, 'a.txt'));

    // With a broken .git/config, git rev-parse itself fails (exit 128) so the
    // checkpoint returns git:false before reaching enumeration. Verify also
    // that if somehow we reach enumeration it fails closed: use a fake exec
    // that says "inside repo" and confirm enumeration drives unavailable.
    const baseEnv = buildGitReadEnv(undefined);
    let tracedResult: Awaited<ReturnType<typeof enumerateFilterDrivers>> | undefined;
    const tracingEnum: CheckpointEnumDrivers = async (...args) => {
      tracedResult = await enumerateFilterDrivers(...args);
      return tracedResult;
    };
    const fakeInsideExec: CheckpointGitExec = async (_cwd, args) => {
      const sub = args.slice(CHECKPOINT_GIT_GLOBAL_ARGS.length);
      if (sub.includes('--is-inside-work-tree')) return { ok: true, stdout: 'true\n' };
      return { ok: true, stdout: 'main\n' };
    };
    const cpExplicit = await captureWorkspaceCheckpoint(r, fakeInsideExec, tracingEnum);
    expect(tracedResult?.ok, `enum must fail for broken config, got: ${JSON.stringify(tracedResult)}`).toBe(false);
    expect(cpExplicit.unavailable).toBe(true);

    // Default path: git fails at rev-parse; filter never runs.
    statDirty(join(r, 'a.txt'));
    const cp = await captureWorkspaceCheckpoint(r);
    expect(existsSync(m), 'checkpoint must never fire the filter').toBe(false);
    expect(cp.git === false || cp.unavailable === true, `expected git:false or unavailable, got ${JSON.stringify(cp)}`).toBe(true);
    void baseEnv;
  });

  it('a repository with no filter drivers: checkpoint succeeds normally', async () => {
    const r = makeRepo('nofilter');
    const cp = await captureWorkspaceCheckpoint(r);
    expect(cp.git).toBe(true);
    expect(cp.unavailable).toBeUndefined();
    expect(cp.head).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
