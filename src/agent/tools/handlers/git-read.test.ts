/**
 * Unit tests for the structured read-only `git_read` tool (#3754): policy
 * allowlist, injection rejection, path confinement, and output bounding,
 * plus a live run against a scratch repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planGitRead, confinePathspec, GIT_READ_SUBCOMMANDS } from '../git-read.policy.js';
import { boundOutput, buildGitReadEnv, createGitReadHandler, GIT_READ_GLOBAL_ARGS, GIT_READ_MAX_BYTES_CEILING } from './git-read.js';

const CWD = '/repo';

function rejected(req: Parameters<typeof planGitRead>[0]): string {
  const plan = planGitRead(req, CWD);
  expect(plan.ok).toBe(false);
  return plan.ok ? '' : plan.error;
}

describe('planGitRead: subcommand allowlist', () => {
  it.each(['commit', 'push', 'checkout', 'reset', 'fetch', 'config', 'clean', 'stash', 'rm', 'am', '!sh', 'difftool'])('rejects %s', (sub) => {
    expect(rejected({ subcommand: sub })).toContain('must be one of');
  });

  it.each([...GIT_READ_SUBCOMMANDS].filter((s) => s !== 'grep'))('accepts bare %s', (sub) => {
    expect(planGitRead({ subcommand: sub }, CWD).ok).toBe(true);
  });

  it('forces --no-ext-diff and --no-textconv on diff/log/show', () => {
    for (const sub of ['diff', 'log', 'show']) {
      const plan = planGitRead({ subcommand: sub }, CWD);
      expect(plan.ok && plan.argv).toEqual([sub, '--no-ext-diff', '--no-textconv', '--']);
    }
  });

  it('tag and branch are list-only', () => {
    const tag = planGitRead({ subcommand: 'tag', args: ['--sort=-creatordate'] }, CWD);
    expect(tag.ok && tag.argv).toEqual(['tag', '--list', '--sort=-creatordate']);
    expect(rejected({ subcommand: 'tag', args: ['v9.9.9'] })).toContain('no revision');
    expect(rejected({ subcommand: 'tag', args: ['-d', 'v1'] })).toContain('Rejected option');
    expect(rejected({ subcommand: 'branch', args: ['-D', 'main'] })).toContain('Rejected option');
    expect(rejected({ subcommand: 'branch', args: ['newbranch'] })).toContain('no revision');
  });
});

describe('planGitRead: injection rejection', () => {
  it.each([
    ['log', ['-c', 'core.pager=sh']],
    ['diff', ['-c', 'diff.external=/bin/x']],
    ['log', ['--output=/tmp/pwn']],
    ['diff', ['--output', '/tmp/pwn']],
    ['diff', ['-o', '/tmp/pwn']],
    ['diff', ['--ext-diff']],
    ['show', ['--textconv']],
    ['log', ['--exec=sh']],
    ['grep', ['-O']],
    ['grep', ['--open-files-in-pager=sh']],
    ['log', ['--config-env=core.pager=X']],
    ['diff', ['--no-index']],
    ['log', ['--show-signature']],
    ['log', ['--format=%GS']],
    ['tag', ['--format=%(signature)']],
    ['tag', ['--format=%(signature:grade)']],
    ['tag', ['--format=%(*signature:grade)']],
    ['branch', ['--format=%(refname) %(SIGNATURE:key)']],
    ['tag', ['--sort=signature:grade']],
    ['branch', ['--sort=-signature']],
    ['log', ['--pretty=%(signature)']],
    ['blame', ['--contents=/etc/passwd']],
    ['show', ['--upload-pack=sh']],
  ])('%s %j is rejected', (sub, args) => {
    const req = sub === 'grep' ? { subcommand: sub, args, pattern: 'x' } : { subcommand: sub, args };
    expect(planGitRead(req, CWD).ok).toBe(false);
  });

  it('rejects revisions with shell or control characters', () => {
    expect(rejected({ subcommand: 'log', args: ['HEAD;rm -rf /'] })).toContain('unsupported');
    expect(rejected({ subcommand: 'log', args: ['$(id)'] })).toContain('unsupported');
    expect(rejected({ subcommand: 'log', args: ['HEAD\n'] })).toContain('control');
  });

  it('pattern beginning with "-" stays a pattern (passed via -e)', () => {
    const plan = planGitRead({ subcommand: 'grep', pattern: '--output=x', args: ['-n', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['grep', '--no-textconv', '--no-color', '-n', '-e', '--output=x', 'HEAD', '--']);
  });

  it('grep requires a pattern; pattern is invalid elsewhere', () => {
    expect(rejected({ subcommand: 'grep' })).toContain('pattern');
    expect(rejected({ subcommand: 'log', pattern: 'x' })).toContain('only valid');
  });

  it('rejects non-array args and too many args', () => {
    expect(rejected({ subcommand: 'log', args: '--oneline' })).toContain('array');
    expect(rejected({ subcommand: 'log', args: Array(41).fill('HEAD') })).toContain('at most');
  });
});

describe('path confinement', () => {
  it('accepts paths inside cwd and passes them after --', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['--oneline'], paths: ['src/a.ts', '/repo/b.ts', '.'] }, CWD);
    expect(plan.ok && plan.argv.slice(-4)).toEqual(['--', 'src/a.ts', 'b.ts', '.']);
  });

  it('treats a literal -- in args as the revision/path separator', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['--oneline', 'main', '--', 'src/a.ts'], paths: ['b.ts'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['log', '--no-ext-diff', '--no-textconv', '--oneline', 'main', '--', 'b.ts', 'src/a.ts']);
  });

  it('confines paths given after -- in args', () => {
    expect(rejected({ subcommand: 'log', args: ['--', '../etc/passwd'] })).toContain('outside the session working directory');
    expect(rejected({ subcommand: 'log', args: ['--', ':(top)x'] })).toContain('pathspec magic');
  });

  it('keeps revisions containing / as revisions', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['origin/main..HEAD'] }, CWD);
    expect(plan.ok && plan.argv.slice(-2)).toEqual(['origin/main..HEAD', '--']);
  });

  it('caps paths merged from args at the entry limit', () => {
    expect(rejected({ subcommand: 'log', args: ['--', 'a'], paths: Array(40).fill('b') })).toContain('at most');
  });

  it.each(['../etc/passwd', '/etc/passwd', 'src/../../x', ':(top)x', ':/x'])('rejects %s', (p) => {
    expect(typeof confinePathspec(CWD, p)).not.toBe('string');
    expect(planGitRead({ subcommand: 'diff', paths: [p] }, CWD).ok).toBe(false);
  });
});

describe('execution hardening', () => {
  it('global args disable pager, external diff and fsmonitor', () => {
    expect(GIT_READ_GLOBAL_ARGS).toEqual(expect.arrayContaining(['--no-pager', 'core.pager=cat', 'diff.external=', 'core.fsmonitor=false']));
  });

  it('global args pin every signature-verification program to false', () => {
    for (const key of ['gpg.program', 'gpg.openpgp.program', 'gpg.ssh.program', 'gpg.x509.program']) {
      const i = GIT_READ_GLOBAL_ARGS.indexOf(`${key}=false`);
      expect(i).toBeGreaterThan(0);
      expect(GIT_READ_GLOBAL_ARGS[i - 1]).toBe('-c');
    }
  });

  it('lowercase reflog placeholders (%gd %gn %ge %gs) are safe', () => {
    expect(planGitRead({ subcommand: 'log', args: ['--format=%gd %gn'] }, CWD).ok).toBe(true);
    expect(planGitRead({ subcommand: 'log', args: ['--pretty=%gd %ge %gs'] }, CWD).ok).toBe(true);
    // literal text containing %g is also safe
    expect(planGitRead({ subcommand: 'log', args: ['--format=100%good'] }, CWD).ok).toBe(true);
  });

  it('signature-free format and sort values are still accepted', () => {
    expect(planGitRead({ subcommand: 'tag', args: ['--format=%(refname:short)', '--sort=-creatordate'] }, CWD).ok).toBe(true);
    expect(planGitRead({ subcommand: 'branch', args: ['--format=%(refname) %(objectname:short)', '--sort=refname'] }, CWD).ok).toBe(true);
  });

  it('%(contents:signature) raw-text format is allowed (no gpg invocation)', () => {
    // %(contents:signature) emits the raw PGP block stored in the tag object —
    // it does NOT invoke gpg.program. Only %(signature) / %G… run the verifier.
    // This test confirms the policy does not over-block the raw-text variant.
    expect(planGitRead({ subcommand: 'tag', args: ['--format=%(contents:signature)'] }, CWD).ok).toBe(true);
    expect(planGitRead({ subcommand: 'log', args: ['--format=%(contents:signature)'] }, CWD).ok).toBe(true);
  });

  it('env pins GIT_PAGER/PAGER/GIT_EDITOR and drops inherited GIT_* overrides', () => {
    const DROPPED = [
      'GIT_DIR', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
      'GIT_PROXY_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    ];
    const before = { ...process.env };
    process.env['GIT_DIR'] = '/elsewhere';
    process.env['GIT_EXTERNAL_DIFF'] = '/bin/evil';
    process.env['GIT_CONFIG_PARAMETERS'] = "'core.pager'='sh'";
    process.env['GIT_SSH_COMMAND'] = '/bin/evil-ssh';
    process.env['GIT_EXEC_PATH'] = '/tmp/evil-libexec';
    process.env['GIT_PROXY_COMMAND'] = '/bin/evil-proxy';
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'core.pager';
    process.env['GIT_CONFIG_VALUE_0'] = 'sh';
    try {
      const e = buildGitReadEnv(undefined);
      for (const k of DROPPED) expect(e[k], k).toBeUndefined();
      expect(e['GIT_PAGER']).toBe('cat');
      expect(e['PAGER']).toBe('cat');
      expect(e['GIT_EDITOR']).toBe(':');
    } finally {
      for (const k of DROPPED) {
        if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
      }
    }
  });

  it('boundOutput truncates to max bytes with a marker', () => {
    const out = boundOutput('x'.repeat(5000), 1000);
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
    expect(out).toContain('truncated: 4000 of 5000 bytes omitted');
    expect(boundOutput('short', 1000)).toBe('short');
  });

  it('boundOutput never splits a multi-byte UTF-8 character', () => {
    // 'é' is 2 bytes; a 5-byte cap lands mid-character on the 3rd one.
    const out = boundOutput('ééééé', 5);
    expect(out.startsWith('éé\n')).toBe(true);
    expect(out).not.toContain('\uFFFD');
    expect(out).toContain('truncated: 6 of 10 bytes omitted');
  });
});

describe('git_read handler (live repo)', () => {
  let repo: string;
  const signal = new AbortController().signal;
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, stdio: 'ignore' }); };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-read-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), `${'line\n'.repeat(3000)}needle\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('tag', 'v1.0.0');
  });
  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  it('runs log, grep and tag listing', async () => {
    const h = createGitReadHandler(repo);
    expect((await h({ subcommand: 'log', args: ['--oneline'] }, signal)).content).toContain('init');
    expect((await h({ subcommand: 'grep', pattern: 'needle', args: ['-n'] }, signal)).content).toContain('a.txt:3001:needle');
    expect((await h({ subcommand: 'grep', pattern: 'absent-zzz' }, signal)).content).toBe('(no matches)');
    expect((await h({ subcommand: 'tag' }, signal)).content).toContain('v1.0.0');
  });

  it('uses the context cwd (resolveBase) over the factory fallback', async () => {
    const h = createGitReadHandler('/nonexistent');
    const r = await h({ subcommand: 'rev-parse', args: ['--show-toplevel'] }, signal, { resolveBase: repo });
    expect(r.isError).toBeFalsy();
  });

  it('bounds output by max_bytes and clamps to the ceiling', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'show', args: ['HEAD'], max_bytes: 500 }, signal);
    expect(String(r.content)).toContain('git_read output truncated');
    expect(Buffer.byteLength(String(r.content).split('\n…')[0] ?? '')).toBeLessThanOrEqual(500);
    const big = await h({ subcommand: 'show', args: ['HEAD'], max_bytes: 10_000_000 }, signal);
    expect(Buffer.byteLength(String(big.content))).toBeLessThanOrEqual(GIT_READ_MAX_BYTES_CEILING + 200);
  });

  it('rejected requests never run git and never write', async () => {
    const h = createGitReadHandler(repo);
    const target = join(repo, 'pwn.txt');
    const r = await h({ subcommand: 'log', args: ['--output=pwn.txt'] }, signal);
    expect(r.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('a git failure surfaces as isError', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'show', args: ['no-such-ref'] }, signal);
    expect(r.isError).toBe(true);
  });
});
