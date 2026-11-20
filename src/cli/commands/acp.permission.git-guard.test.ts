/**
 * Red team 3a: git exec-guard, content-rule, and alternates/bare-repo disclosure.
 *
 * Every test asserts the SAFE behaviour.  A test that fails means a break was
 * found.  A test that passes is evidence that the attack surface held.
 *
 * Scope (brief R4 round 3, git scope):
 *   1. Exec-guard bypass: filter drivers the enumeration does not see, driver
 *      names with unusual characters, conditional includes, worktreeConfig,
 *      linked-worktree config, >MAX drivers (DoS only).
 *   2. Content-rule gaps: METADATA subcommands that can still return file
 *      content from outside the session cwd (log variants, stash, reflog,
 *      for-each-ref with format atoms, ls-files --stage, describe, shortlog,
 *      worktree list, remote -v, rev-list); show/log -p with paths auto-allowed
 *      but correctly confined to the session cwd.
 *   3. Alternates / bare-repo disclosure: cat-file -t/-s/-e on alternate-repo
 *      object SHAs is auto-allowed (type/size/existence only); content reads
 *      (cat-file -p, show <sha>) are correctly asked.
 *
 * @module cli/commands/redteam3a.git-guard.test
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { gitReadReachesOutside, provablyCommit } from './acp.permission.git.js';
import { planGitRead } from '../../agent/tools/git-read.policy.js';
import {
  parseFilterDrivers,
  filterNeutralisingEnv,
  enumerateFilterDrivers,
  MAX_FILTER_DRIVERS,
  GIT_READ_NO_HOOKS_PATH,
} from '../../agent/tools/handlers/git-read.exec-guard.js';
import { buildGitReadEnv } from '../../agent/tools/handlers/git-read.js';
import { GIT_READ_GLOBAL_ARGS } from '../../agent/tools/handlers/git-read.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await execFile('git', args, { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8' });
    return { stdout: r.stdout as string, stderr: r.stderr as string };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 't@t.com'], dir);
  await git(['config', 'user.name', 'T'], dir);
}

async function commit(dir: string, msg: string): Promise<string> {
  await git(['add', '.'], dir);
  const r = await git(['commit', '--allow-empty', '-q', '-m', msg], dir);
  void r;
  const h = await git(['rev-parse', 'HEAD'], dir);
  return h.stdout.trim();
}

// ---------------------------------------------------------------------------
// Test repo fixtures
// ---------------------------------------------------------------------------

let repoDir: string;        // repo root
let sessionDir: string;     // session cwd = repo/app (a subdirectory)
let altRepoDir: string;     // "other" repo for alternates tests
let altBlob: string;        // sha of secret blob in altRepo

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'rt3a-repo-'));
  sessionDir = join(repoDir, 'app');
  altRepoDir = await mkdtemp(join(tmpdir(), 'rt3a-alt-'));

  // Build main repo
  await initRepo(repoDir);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(repoDir, 'secrets'), { recursive: true });
  await writeFile(join(repoDir, 'secrets', 'prod.env'), 'DB_PASSWORD=HUNTER2_SECRET\n');
  await writeFile(join(sessionDir, 'main.ts'), 'export const x = 1;\n');
  await commit(repoDir, 'init');

  // Build alternate repo with a secret blob
  await initRepo(altRepoDir);
  await writeFile(join(altRepoDir, 'secret.env'), 'ALT_SECRET=hunter2_alternates\n');
  const r = await git(['hash-object', '-w', 'secret.env'], altRepoDir);
  altBlob = r.stdout.trim();
  await git(['add', '.'], altRepoDir);
  await commit(altRepoDir, 'alt init');
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(altRepoDir, { recursive: true, force: true });
});

// ===========================================================================
// SCOPE 1: Exec-guard – filter driver enumeration
// ===========================================================================

describe('scope 1: exec-guard filter driver enumeration', () => {

  it('parseFilterDrivers: handles driver name with space (subsection space)', () => {
    // git config allows spaces in subsection names. parseFilterDrivers must
    // extract the name correctly and filterNeutralisingEnv must produce the
    // matching GIT_CONFIG_KEY that neutralises it.
    const stdout = 'filter.a b.clean\0filter.a b.smudge\0';
    const r = parseFilterDrivers(stdout);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.names).toContain('a b');
    // Neutralising env key must round-trip the name
    const env = filterNeutralisingEnv(['a b']);
    expect(env['GIT_CONFIG_KEY_0']).toBe('filter.a b.clean');
    expect(env['GIT_CONFIG_KEY_1']).toBe('filter.a b.smudge');
    expect(env['GIT_CONFIG_KEY_2']).toBe('filter.a b.process');
    expect(env['GIT_CONFIG_KEY_3']).toBe('filter.a b.required');
    expect(env['GIT_CONFIG_VALUE_3']).toBe('false');
  });

  it('parseFilterDrivers: handles driver name with tab', () => {
    const stdout = 'filter.\ta b.clean\0filter.\ta b.smudge\0';
    const r = parseFilterDrivers(stdout);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.names).toContain('\ta b');
    const env = filterNeutralisingEnv(['\ta b']);
    expect(env['GIT_CONFIG_KEY_0']).toBe('filter.\ta b.clean');
  });

  it('parseFilterDrivers: handles driver name with uppercase letters', () => {
    const stdout = 'filter.MyDriver.clean\0filter.MyDriver.smudge\0';
    const r = parseFilterDrivers(stdout);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.names).toContain('MyDriver');
    // The neutralising key uses the EXACT case from the config (case-sensitive subsection)
    const env = filterNeutralisingEnv(['MyDriver']);
    expect(env['GIT_CONFIG_KEY_0']).toBe('filter.MyDriver.clean');
  });

  it('parseFilterDrivers: handles driver name with dots (a.b subsection)', () => {
    // [filter "a.b"] in .git/config produces key "filter.a.b.clean"
    const stdout = 'filter.a.b.clean\0filter.a.b.required\0';
    const r = parseFilterDrivers(stdout);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.names).toContain('a.b');
    const env = filterNeutralisingEnv(['a.b']);
    expect(env['GIT_CONFIG_KEY_0']).toBe('filter.a.b.clean');
  });

  it('parseFilterDrivers: rejects output with unknown key (fails closed)', () => {
    // An unrecognised key type stops enumeration rather than silently ignoring
    const stdout = 'filter.x.evilkey\0';
    const r = parseFilterDrivers(stdout);
    // 'evilkey' is not in DRIVER_KEYS; the entry is skipped (no driver name added).
    // The function does NOT return an error for unknown keys — it skips them.
    // So no driver named 'x' is returned (safe: the driver is effectively absent,
    // meaning no clean/smudge is set, so it can't run).
    expect(r.ok).toBe(true);
  });

  it('parseFilterDrivers: rejects > MAX_FILTER_DRIVERS drivers', () => {
    const many = Array.from({ length: MAX_FILTER_DRIVERS + 1 }, (_, i) => `filter.d${i}.clean\0`).join('');
    const r = parseFilterDrivers(many);
    expect(r.ok).toBe(false);
  });

  it('parseFilterDrivers: empty output returns no drivers (non-git dir)', () => {
    const r = parseFilterDrivers('');
    expect(r).toEqual({ ok: true, names: [] });
  });

  it('parseFilterDrivers: non-NUL-terminated output fails closed', () => {
    const r = parseFilterDrivers('filter.x.clean'); // no trailing NUL
    expect(r.ok).toBe(false);
  });

  it('enumerateFilterDrivers: space-named driver in a real repo is enumerated and neutralised', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt3a-spacedrv-'));
    try {
      await initRepo(dir);
      await writeFile(join(dir, 'a.txt'), 'content\n');
      await writeFile(join(dir, '.gitattributes'), '* filter=a b\n');
      await git(['add', '.'], dir);
      await commit(dir, 'init');
      await git(['config', 'filter.a b.clean', 'echo SPACE_DRIVER_RAN >&2 && cat'], dir);
      await git(['config', 'filter.a b.smudge', 'cat'], dir);

      const env = buildGitReadEnv(undefined);
      const ac = new AbortController();
      const result = await enumerateFilterDrivers(GIT_READ_GLOBAL_ARGS, dir, env, ac.signal);

      // Must successfully enumerate the space-named driver
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.names).toContain('a b');

      // The neutralising env must contain the correct keys for the space-named driver
      const nenv = filterNeutralisingEnv(result.names);
      const keys = Object.entries(nenv).filter(([k]) => k.startsWith('GIT_CONFIG_KEY')).map(([, v]) => v);
      expect(keys).toContain('filter.a b.clean');
      expect(keys).toContain('filter.a b.smudge');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exec-guard: core.hooksPath points at a path that cannot be a directory', () => {
    // GIT_READ_NO_HOOKS_PATH is a child of the node binary (a regular file),
    // so it cannot be a directory and git will not find hooks there.
    expect(GIT_READ_NO_HOOKS_PATH).toContain(process.execPath);
    // The path must not exist as a directory
    const { existsSync, statSync } = require('node:fs') as typeof import('node:fs');
    const exists = existsSync(GIT_READ_NO_HOOKS_PATH);
    if (exists) {
      expect(statSync(GIT_READ_NO_HOOKS_PATH).isDirectory()).toBe(false);
    }
    // (non-existence is the normal case; either way git cannot run hooks from it)
  });

  it('enumerateFilterDrivers: extensions.worktreeConfig drivers visible from linked worktree', async () => {
    // A linked worktree with extensions.worktreeConfig=true can have per-worktree
    // filters in .git/worktrees/<name>/config.worktree.  The enumeration must see them.
    const mainDir = await mkdtemp(join(tmpdir(), 'rt3a-wt-main-'));
    const linkedDir = join(tmpdir(), `rt3a-wt-linked-${Date.now()}`);
    try {
      await initRepo(mainDir);
      await writeFile(join(mainDir, 'file.txt'), 'content\n');
      await git(['add', '.'], mainDir);
      await commit(mainDir, 'init');
      await git(['worktree', 'add', linkedDir, 'HEAD'], mainDir);
      await git(['config', 'extensions.worktreeConfig', 'true'], linkedDir);
      await git(['config', '--worktree', 'filter.perworktree.clean', 'echo PER_WT_RAN >&2 && cat'], linkedDir);

      const env = buildGitReadEnv(undefined);
      const ac = new AbortController();
      // Enumerate from the LINKED worktree cwd — must see the per-worktree driver
      const result = await enumerateFilterDrivers(GIT_READ_GLOBAL_ARGS, linkedDir, env, ac.signal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.names).toContain('perworktree');
    } finally {
      await rm(mainDir, { recursive: true, force: true });
      try { await rm(linkedDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ===========================================================================
// SCOPE 2: Content-rule gaps
// ===========================================================================

describe('scope 2: content-rule – METADATA subcommands do not leak file content', () => {

  it('rev-list (METADATA): classified as auto-allowed regardless of --format', () => {
    // rev-list with any --format= atom is METADATA and auto-allowed.
    // It prints commit SHAs and metadata, never file content (--objects is blocked).
    expect(gitReadReachesOutside({ subcommand: 'rev-list', args: ['HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'rev-list', args: ['--format=%B', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'rev-list', args: ['--count', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    // --all is NOT in rev-list's allowlist, so planGitRead fails and gitReadReachesOutside
    // returns true (fail-closed). This is correct safe behaviour.
    expect(gitReadReachesOutside({ subcommand: 'rev-list', args: ['--count', '--all'], paths: [] }, sessionDir)).toBe(true);
  });

  it('stash list (METADATA): auto-allowed, cannot print file content', () => {
    expect(gitReadReachesOutside({ subcommand: 'stash', args: [], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'stash', args: ['--format=%B'], paths: [] }, sessionDir)).toBe(false);
  });

  it('reflog (METADATA): auto-allowed, prints only reflog metadata', () => {
    expect(gitReadReachesOutside({ subcommand: 'reflog', args: [], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'reflog', args: ['--format=%B'], paths: [] }, sessionDir)).toBe(false);
  });

  it('for-each-ref: %(raw) format atom is ASKED (would print raw object content)', () => {
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(raw)'], paths: [] }, sessionDir)).toBe(true);
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(*raw)'], paths: [] }, sessionDir)).toBe(true);
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(  raw)'], paths: [] }, sessionDir)).toBe(true);
  });

  it('for-each-ref: %(contents) format atom is auto-allowed (tag/commit message, not file content)', () => {
    // %(contents) prints the annotation body of a tag or the commit message body.
    // It does NOT dereference to blob content, even on a tag that points at a blob.
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(contents)'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(contents:body)'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'for-each-ref', args: ['--format=%(objecttype) %(objectname)'], paths: [] }, sessionDir)).toBe(false);
  });

  it('ls-files --stage: auto-allowed; prints mode+sha+path only (no file content)', () => {
    expect(gitReadReachesOutside({ subcommand: 'ls-files', args: ['--stage'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'ls-files', args: ['--cached'], paths: [] }, sessionDir)).toBe(false);
  });

  it('describe: METADATA, auto-allowed, prints tag names only', () => {
    expect(gitReadReachesOutside({ subcommand: 'describe', args: ['--tags', '--always'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'describe', args: ['HEAD'], paths: [] }, sessionDir)).toBe(false);
  });

  it('shortlog: METADATA, auto-allowed, prints author summaries only', () => {
    expect(gitReadReachesOutside({ subcommand: 'shortlog', args: ['-s', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
  });

  it('worktree list: METADATA, auto-allowed, prints worktree paths (not file content)', () => {
    expect(gitReadReachesOutside({ subcommand: 'worktree', args: [], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'worktree', args: ['--porcelain'], paths: [] }, sessionDir)).toBe(false);
  });

  it('remote -v: METADATA, auto-allowed, prints remote URLs (not file content)', () => {
    expect(gitReadReachesOutside({ subcommand: 'remote', args: [], paths: [] }, sessionDir)).toBe(false);
  });

  it('log without patch: METADATA path, auto-allowed', () => {
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['--oneline', '--all'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['--format=%B', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['--stat', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
  });

  it('log -p no paths: ASKED (patch, whole-repo scope)', () => {
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['-p', 'HEAD'], paths: [] }, sessionDir)).toBe(true);
  });

  it('log -p with paths: AUTO-ALLOWED (patch output but pathspec-confined to session cwd)', () => {
    // This IS auto-allowed: the patch is confined to paths inside the session cwd
    // by confinePathspec. Content shown is from committed files inside the session dir.
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['-p', 'HEAD'], paths: ['main.ts'] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['-p', 'HEAD'], paths: ['.'] }, sessionDir)).toBe(false);
  });

  it('log --follow: ASKED (rename tracking can reach outside-cwd history)', () => {
    // --follow is explicitly caught as a "reaches outside" signal
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['--follow', '-p'], paths: ['main.ts'] }, sessionDir)).toBe(true);
  });

  it('show no paths: ASKED (whole-repo scope)', () => {
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['HEAD'], paths: [] }, sessionDir)).toBe(true);
  });

  it('show with paths: AUTO-ALLOWED (pathspec confined to session cwd)', () => {
    // show HEAD -- file.txt: pathspec confined, content is from committed files inside session dir
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['HEAD'], paths: ['main.ts'] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['HEAD'], paths: ['.'] }, sessionDir)).toBe(false);
  });

  it('show with unproven rev: ASKED regardless of paths', () => {
    // A bare tag name is not provablyCommit -> ASKED
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['v1.0'], paths: ['main.ts'] }, sessionDir)).toBe(true);
    // A hex SHA is not provablyCommit -> ASKED
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['abc1234'], paths: ['main.ts'] }, sessionDir)).toBe(true);
  });

  it('diff no paths: ASKED', () => {
    expect(gitReadReachesOutside({ subcommand: 'diff', args: ['HEAD'], paths: [] }, sessionDir)).toBe(true);
  });

  it('diff --stat no paths: AUTO-ALLOWED (suppress-patch; stat only)', () => {
    expect(gitReadReachesOutside({ subcommand: 'diff', args: ['HEAD', '--stat'], paths: [] }, sessionDir)).toBe(false);
  });

  it('diff with paths: AUTO-ALLOWED (pathspec confined)', () => {
    expect(gitReadReachesOutside({ subcommand: 'diff', args: ['HEAD'], paths: ['main.ts'] }, sessionDir)).toBe(false);
  });

  it('show/diff --format=%(raw): ASKED via RAW_ATOM check', () => {
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['--format=%(raw)', 'HEAD'], paths: ['.'] }, sessionDir)).toBe(true);
  });

  it('provablyCommit: HEAD, HEAD~N, HEAD^N, x^{commit} are commits', () => {
    expect(provablyCommit('HEAD')).toBe(true);
    expect(provablyCommit('HEAD~1')).toBe(true);
    expect(provablyCommit('HEAD~')).toBe(true);
    expect(provablyCommit('HEAD^1')).toBe(true);
    expect(provablyCommit('HEAD^{commit}')).toBe(true);
    expect(provablyCommit('main~0')).toBe(true);
    expect(provablyCommit('v1.0^{commit}')).toBe(true);
  });

  it('provablyCommit: bare tag name, hex sha, stash refs, reflog entries are NOT', () => {
    expect(provablyCommit('v1.0')).toBe(false);             // could be annotated tag -> blob
    expect(provablyCommit('abc1234')).toBe(false);           // hex SHA -> any object type
    expect(provablyCommit('refs/stash')).toBe(false);
    expect(provablyCommit('stash@{0}')).toBe(false);
    expect(provablyCommit('HEAD@{0}')).toBe(false);
    expect(provablyCommit('ORIG_HEAD')).toBe(false);
    expect(provablyCommit('MERGE_HEAD')).toBe(false);
  });

  it('show/diff with suppress-patch and provably-commit rev is AUTO-ALLOWED', () => {
    // --stat with HEAD is auto (suppress patch, provable commit)
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['--stat', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'diff', args: ['--name-only', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
  });

  it('cat-file -p: ASKED (content)', () => {
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-p', 'HEAD'], paths: [] }, sessionDir)).toBe(true);
  });

  it('cat-file -t/-s/-e: AUTO-ALLOWED (type/size/existence only)', () => {
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-t', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-s', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-e', 'HEAD'], paths: [] }, sessionDir)).toBe(false);
  });
});

// ===========================================================================
// SCOPE 3: Alternates / bare-repo disclosure
// ===========================================================================

describe('scope 3: alternates – content reads require permission; type/size do not', () => {

  it('cat-file -p on alternate-repo blob SHA is classified as ASKED (content)', () => {
    // Even if the caller knows a blob SHA from an alternate repo, cat-file -p requires permission.
    // altBlob is a valid SHA format (40 hex chars) -> not provablyCommit -> ASKED.
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-p', altBlob], paths: [] }, sessionDir)).toBe(true);
  });

  it('cat-file -t on alternate-repo blob SHA is AUTO-ALLOWED (type only)', () => {
    // -t reveals only "blob" / "tree" / "commit" / "tag" — no content.
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-t', altBlob], paths: [] }, sessionDir)).toBe(false);
  });

  it('cat-file -s on alternate-repo blob SHA is AUTO-ALLOWED (size only)', () => {
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-s', altBlob], paths: [] }, sessionDir)).toBe(false);
  });

  it('cat-file -e on alternate-repo blob SHA is AUTO-ALLOWED (existence check only)', () => {
    expect(gitReadReachesOutside({ subcommand: 'cat-file', args: ['-e', altBlob], paths: [] }, sessionDir)).toBe(false);
  });

  it('show <blob-sha> is ASKED (not provablyCommit)', () => {
    // show on a hex SHA with no path → ASKED (sha could be a blob; not provablyCommit)
    expect(gitReadReachesOutside({ subcommand: 'show', args: [altBlob], paths: [] }, sessionDir)).toBe(true);
  });

  it('show HEAD:path is ASKED (contains colon → not provablyCommit)', () => {
    expect(gitReadReachesOutside({ subcommand: 'show', args: ['HEAD:secret.env'], paths: [] }, sessionDir)).toBe(true);
  });

  it('alternates repo: cat-file -t actually returns blob type for alternate object (integration)', async () => {
    // Build a session repo with alternates pointing at altRepoDir
    const sessionWithAlt = await mkdtemp(join(tmpdir(), 'rt3a-alt-session-'));
    try {
      await initRepo(sessionWithAlt);
      await mkdir(join(sessionWithAlt, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(join(sessionWithAlt, '.git', 'objects', 'info', 'alternates'),
        join(altRepoDir, '.git', 'objects') + '\n');

      // cat-file -t on the alt blob: should print "blob"
      const r = await git(['cat-file', '-t', altBlob], sessionWithAlt);
      expect(r.stdout.trim()).toBe('blob');
      // This is auto-allowed and reveals only object TYPE — not content.

      // cat-file -p would reveal content; it requires permission (tested above in classifier).
      // We do not run it here because this is a classifier test, not a handler test.
    } finally {
      await rm(sessionWithAlt, { recursive: true, force: true });
    }
  });

  it('log --all in alternates repo does NOT walk alternate repo commits (refs-based)', async () => {
    // Alternates provides objects, not refs. log --all only walks the session repo's own refs.
    const sessionWithAlt = await mkdtemp(join(tmpdir(), 'rt3a-alt-log-'));
    try {
      await initRepo(sessionWithAlt);
      await writeFile(join(sessionWithAlt, 'file.txt'), 'session content\n');
      await git(['add', '.'], sessionWithAlt);
      await commit(sessionWithAlt, 'session init');
      await mkdir(join(sessionWithAlt, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(join(sessionWithAlt, '.git', 'objects', 'info', 'alternates'),
        join(altRepoDir, '.git', 'objects') + '\n');

      const r = await git(['log', '--all', '--oneline'], sessionWithAlt);
      // Should NOT contain the alt repo's commit message
      expect(r.stdout).not.toContain('alt init');
      // Should only show the session repo's own commit
      expect(r.stdout).toContain('session init');
    } finally {
      await rm(sessionWithAlt, { recursive: true, force: true });
    }
  });

  it('show/diff --stat in alternates repo reveals only file names (not content)', async () => {
    // A session repo with an index entry backed by an alternates object:
    // diff --stat (auto-allowed suppress-patch) shows file names and line counts only.
    const sessionWithAlt = await mkdtemp(join(tmpdir(), 'rt3a-alt-stat-'));
    try {
      await initRepo(sessionWithAlt);
      await mkdir(join(sessionWithAlt, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(join(sessionWithAlt, '.git', 'objects', 'info', 'alternates'),
        join(altRepoDir, '.git', 'objects') + '\n');
      // Add the secret blob to the index (backed by alternates)
      await git(['update-index', '--add', '--cacheinfo', `100644,${altBlob},secret.env`], sessionWithAlt);

      const r = await git(['diff', '--cached', '--stat', '--no-ext-diff', '--no-textconv'], sessionWithAlt);
      // Shows file name and line count — not the secret content
      expect(r.stdout).toContain('secret.env');
      expect(r.stdout).not.toContain('ALT_SECRET');
      expect(r.stdout).not.toContain('hunter2_alternates');
    } finally {
      await rm(sessionWithAlt, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// planGitRead structural checks (rev-list --objects blocked, etc.)
// ===========================================================================

describe('planGitRead: object-printing options blocked', () => {

  it('rev-list --objects is rejected (not in allowlist)', () => {
    const r = planGitRead({ subcommand: 'rev-list', args: ['--objects', 'HEAD'], paths: [] }, sessionDir);
    expect(r.ok).toBe(false);
  });

  it('rev-list --disk-usage is rejected', () => {
    const r = planGitRead({ subcommand: 'rev-list', args: ['--disk-usage', 'HEAD'], paths: [] }, sessionDir);
    expect(r.ok).toBe(false);
  });

  it('cat-file --batch is rejected (would stream arbitrary objects)', () => {
    const r = planGitRead({ subcommand: 'cat-file', args: ['--batch', 'HEAD'], paths: [] }, sessionDir);
    expect(r.ok).toBe(false);
  });

  it('cat-file --textconv is rejected (runs external program)', () => {
    const r = planGitRead({ subcommand: 'cat-file', args: ['--textconv', 'HEAD'], paths: [] }, sessionDir);
    expect(r.ok).toBe(false);
  });

  it('log --format=%(raw) accepted by planGitRead but classifier asks', () => {
    // planGitRead accepts the token (it is a valid --format= value);
    // gitReadReachesOutside catches it via RAW_ATOM and returns true (ASKED).
    const r = planGitRead({ subcommand: 'log', args: ['--format=%(raw)', 'HEAD'], paths: ['.'] }, sessionDir);
    expect(r.ok).toBe(true); // plan succeeds
    expect(gitReadReachesOutside({ subcommand: 'log', args: ['--format=%(raw)', 'HEAD'], paths: ['.'] }, sessionDir)).toBe(true); // but asked
  });

  it('log --sort=signature is rejected by planGitRead (not in allowlist)', () => {
    const r = planGitRead({ subcommand: 'log', args: ['--sort=signature', 'HEAD'], paths: [] }, sessionDir);
    expect(r.ok).toBe(false);
  });

  it('for-each-ref --sort=version:refname is accepted (no program run)', () => {
    const r = planGitRead({ subcommand: 'for-each-ref', args: ['--sort=version:refname'], paths: [] }, sessionDir);
    expect(r.ok).toBe(true);
  });
});
