/**
 * Unit tests for the structured read-only `git_read` tool (#3754, #4058): policy
 * allowlist, injection rejection, path confinement, and output bounding,
 * plus a live run against a scratch repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  it.each(['commit', 'push', 'checkout', 'reset', 'fetch', 'config', 'clean', 'rm', 'am', '!sh', 'difftool'])('rejects %s', (sub) => {
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

  it('a bad revision (exit 128) appends the discover-refs hint', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'show', args: ['no-such-ref'] }, signal);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('git exited 128');
    expect(String(r.content)).toContain('Do not retry with the same revision');
  });
});

// ---------------------------------------------------------------------------
// Tests for #4058 new subcommands
// ---------------------------------------------------------------------------

describe('planGitRead (#4058): new subcommand allowlist', () => {
  it('accepts all new subcommands with no args', () => {
    const newSubs = ['merge-base', 'rev-list', 'reflog', 'for-each-ref', 'describe', 'shortlog', 'cat-file', 'remote', 'stash', 'worktree'] as const;
    for (const sub of newSubs) {
      const plan = planGitRead({ subcommand: sub }, CWD);
      expect(plan.ok, `${sub} should be accepted`).toBe(true);
    }
  });

  it('rejects old unlisted subcommands still', () => {
    for (const sub of ['commit', 'push', 'fetch', 'config', 'ls-remote']) {
      expect(planGitRead({ subcommand: sub }, CWD).ok).toBe(false);
    }
  });

  it('forces reflog to show', () => {
    const plan = planGitRead({ subcommand: 'reflog' }, CWD);
    expect(plan.ok && plan.argv).toEqual(['reflog', 'show']);
  });

  it('reflog with explicit ref', () => {
    const plan = planGitRead({ subcommand: 'reflog', args: ['--oneline', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['reflog', 'show', '--oneline', 'HEAD']);
  });

  it('forces remote to -v', () => {
    const plan = planGitRead({ subcommand: 'remote' }, CWD);
    expect(plan.ok && plan.argv).toEqual(['remote', '-v']);
  });

  it('forces stash to list', () => {
    const plan = planGitRead({ subcommand: 'stash' }, CWD);
    expect(plan.ok && plan.argv).toEqual(['stash', 'list']);
  });

  it('forces worktree to list', () => {
    const plan = planGitRead({ subcommand: 'worktree' }, CWD);
    expect(plan.ok && plan.argv).toEqual(['worktree', 'list']);
  });

  it('shortlog injects HEAD when no rev supplied', () => {
    const plan = planGitRead({ subcommand: 'shortlog', args: ['-s', '-n'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['shortlog', '-s', '-n', 'HEAD']);
  });

  it('shortlog with explicit rev does not double-inject HEAD', () => {
    const plan = planGitRead({ subcommand: 'shortlog', args: ['-s', 'main'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['shortlog', '-s', 'main']);
  });

  it('merge-base accepts --is-ancestor and revs', () => {
    const plan = planGitRead({ subcommand: 'merge-base', args: ['--is-ancestor', 'HEAD~1', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['merge-base', '--is-ancestor', 'HEAD~1', 'HEAD']);
  });

  it('rev-list with --count', () => {
    const plan = planGitRead({ subcommand: 'rev-list', args: ['--count', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['rev-list', '--count', 'HEAD']);
  });

  it('for-each-ref with --format and --sort', () => {
    const plan = planGitRead({ subcommand: 'for-each-ref', args: ['--format=%(refname:short)', '--sort=-creatordate'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['for-each-ref', '--format=%(refname:short)', '--sort=-creatordate']);
  });

  it('describe with --tags and rev', () => {
    const plan = planGitRead({ subcommand: 'describe', args: ['--tags', '--always', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['describe', '--tags', '--always', 'HEAD']);
  });

  it('cat-file -t and -p', () => {
    expect(planGitRead({ subcommand: 'cat-file', args: ['-t', 'HEAD'] }, CWD).ok).toBe(true);
    expect(planGitRead({ subcommand: 'cat-file', args: ['-p', 'HEAD'] }, CWD).ok).toBe(true);
  });

  it('log accepts --diff-filter= (regression from issue)', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['--diff-filter=M', '--oneline'] }, CWD);
    expect(plan.ok).toBe(true);
  });

  it('log accepts -n (shorthand for --max-count)', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['-n', '5', '--oneline'] }, CWD);
    expect(plan.ok).toBe(true);
    // -n 5 is normalised to --max-count=5 by the count-shorthand rewriter
    expect(plan.ok && plan.argv).toContain('--max-count=5');
  });

  it('log accepts -i and --regexp-ignore-case (case-insensitive grep)', () => {
    const planI = planGitRead({ subcommand: 'log', args: ['-i', '--grep=fix', '--oneline'] }, CWD);
    expect(planI.ok).toBe(true);
    const planLong = planGitRead({ subcommand: 'log', args: ['--regexp-ignore-case', '--grep=fix'] }, CWD);
    expect(planLong.ok).toBe(true);
  });

  it('log accepts --not (revision exclusion)', () => {
    const plan = planGitRead({ subcommand: 'log', args: ['--oneline', '--not', 'origin/main'] }, CWD);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.argv).toContain('--not');
  });

  it('rev-list accepts --not (revision exclusion)', () => {
    const plan = planGitRead({ subcommand: 'rev-list', args: ['--count', 'HEAD', '--not', 'origin/main'] }, CWD);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.argv).toContain('--not');
  });
});

// ---------------------------------------------------------------------------
// Tests for #4227: model-quirk normalization (count shorthand, empty pattern,
// echoed subcommand). None of these widen the read-only surface — each maps
// onto a form the allowlist already accepts.
// ---------------------------------------------------------------------------

describe('planGitRead (#4227): model-quirk normalization', () => {
  it('normalizes count shorthand to --max-count=', () => {
    for (const args of [['-5'], ['-n', '5'], ['-n5']]) {
      for (const sub of ['log', 'rev-list'] as const) {
        const plan = planGitRead({ subcommand: sub, args }, CWD);
        expect(plan.ok, `${sub} ${args.join(' ')}`).toBe(true);
        if (plan.ok) expect(plan.argv, `${sub} ${args.join(' ')}`).toContain('--max-count=5');
      }
    }
  });

  it('keeps shortlog -n (numbered) verbatim and only pairs -n with a value for log/rev-list', () => {
    // shortlog: -n is --numbered there, not a count.
    const s = planGitRead({ subcommand: 'shortlog', args: ['-s', '-n'] }, CWD);
    expect(s.ok && s.argv).toEqual(['shortlog', '-s', '-n', 'HEAD']);
    // shortlog with a paired -n <N> normalizes to a count (git's shortlog -n
    // <N> is ambiguous in practice; the count reading is the model-quirk one).
    const s2 = planGitRead({ subcommand: 'shortlog', args: ['-n', '3'] }, CWD);
    expect(s2.ok && s2.argv).toEqual(['shortlog', '--max-count=3', 'HEAD']);
    // A bare -n followed by another flag stays verbatim for shortlog (legacy
    // shape preserved: `-n` = --numbered, as in `shortlog -s -n`).
    const s3 = planGitRead({ subcommand: 'shortlog', args: ['-n', '-e'] }, CWD);
    expect(s3.ok && s3.argv).toEqual(['shortlog', '-n', '-e', 'HEAD']);
  });

  it('rejects -n with a non-numeric value for log/rev-list', () => {
    expect(rejected({ subcommand: 'log', args: ['-n', 'abc'] })).toContain('non-negative integer');
    expect(rejected({ subcommand: 'log', args: ['-nabc'] })).toContain('Rejected option');
    expect(rejected({ subcommand: 'log', args: ['-n'] })).toContain('expects --max-count=');
    expect(rejected({ subcommand: 'rev-list', args: ['-n', 'abc'] })).toContain('non-negative integer');
  });

  it('treats an empty or whitespace-only pattern as absent for non-grep subcommands', () => {
    const a = planGitRead({ subcommand: 'log', args: ['--oneline'], pattern: '' }, CWD);
    expect(a.ok && a.argv).toEqual(['log', '--no-ext-diff', '--no-textconv', '--oneline', '--']);
    expect(planGitRead({ subcommand: 'show', args: ['HEAD'], pattern: '  ' }, CWD).ok).toBe(true);
    // grep still requires a real pattern — the empty string is not a search term.
    expect(rejected({ subcommand: 'grep', pattern: '' })).toContain('non-empty');
    // ...but a whitespace-only grep pattern is a legitimate search (literal
    // spaces / indentation) and must be passed through unchanged via -e.
    for (const ws of [' ', '\t', '  ']) {
      const g = planGitRead({ subcommand: 'grep', pattern: ws }, CWD);
      expect(g.ok, JSON.stringify(ws)).toBe(true);
      if (g.ok) {
        const i = g.argv.indexOf('-e');
        expect(i, JSON.stringify(ws)).toBeGreaterThan(-1);
        expect(g.argv[i + 1], JSON.stringify(ws)).toBe(ws);
      }
    }
    // A non-empty pattern on a non-grep subcommand is still rejected.
    expect(rejected({ subcommand: 'log', pattern: 'x' })).toContain('only valid');
  });

  it('drops a leading subcommand echoed into args', () => {
    const plan = planGitRead({ subcommand: 'show', args: ['show', 'HEAD'] }, CWD);
    expect(plan.ok && plan.argv).toEqual(['show', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
    const plan2 = planGitRead({ subcommand: 'log', args: ['log', '--oneline'] }, CWD);
    expect(plan2.ok && plan2.argv).toEqual(['log', '--no-ext-diff', '--no-textconv', '--oneline', '--']);
  });
});

describe('planGitRead (#4058): injection rejection for new subcommands', () => {
  it('rejects write-mode reflog subcommands via rev allowlist', () => {
    // "expire" starts with a letter so would pass REV_RE; but reflog forces `show`
    // first — `expire` would be treated as a rev and hit git with `reflog show expire`
    // which is a harmless no-op (unknown ref). The real guard is that `expire`/`delete`
    // can never appear as the first positional because `forced` owns that slot.
    // We verify the option-injection vector is blocked:
    expect(planGitRead({ subcommand: 'reflog', args: ['--expire=now'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'reflog', args: ['--expire-unreachable=now'] }, CWD).ok).toBe(false);
  });

  it('rejects stash write flags', () => {
    expect(planGitRead({ subcommand: 'stash', args: ['push'] }, CWD).ok).toBe(false); // revs: false
    expect(planGitRead({ subcommand: 'stash', args: ['-m', 'msg'] }, CWD).ok).toBe(false);
  });

  it('rejects worktree write flags', () => {
    expect(planGitRead({ subcommand: 'worktree', args: ['add'] }, CWD).ok).toBe(false); // revs: false
    expect(planGitRead({ subcommand: 'worktree', args: ['--porcelain', 'add'] }, CWD).ok).toBe(false);
  });

  it('rejects remote write variants', () => {
    expect(planGitRead({ subcommand: 'remote', args: ['add'] }, CWD).ok).toBe(false); // revs: false
    expect(planGitRead({ subcommand: 'remote', args: ['set-url', 'origin', 'x'] }, CWD).ok).toBe(false);
  });

  it('rejects cat-file --batch and --textconv', () => {
    expect(planGitRead({ subcommand: 'cat-file', args: ['--batch'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'cat-file', args: ['--batch-all-objects'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'cat-file', args: ['--textconv', 'HEAD:file'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'cat-file', args: ['--filters', 'HEAD:file'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'cat-file', args: ['--path=/etc/passwd', 'HEAD'] }, CWD).ok).toBe(false);
  });

  it('rejects for-each-ref signature format/sort', () => {
    expect(planGitRead({ subcommand: 'for-each-ref', args: ['--format=%(signature)'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'for-each-ref', args: ['--sort=signature'] }, CWD).ok).toBe(false);
  });

  it('rejects rev-list --stdin and --objects', () => {
    expect(planGitRead({ subcommand: 'rev-list', args: ['--stdin'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'rev-list', args: ['--objects'] }, CWD).ok).toBe(false);
  });

  it('rejects paths on no-path subcommands', () => {
    for (const sub of ['remote', 'stash', 'worktree', 'for-each-ref', 'reflog'] as const) {
      expect(planGitRead({ subcommand: sub, paths: ['src/'] }, CWD).ok).toBe(false);
    }
  });

  it('injection via revision slot is blocked by REV_RE', () => {
    expect(planGitRead({ subcommand: 'rev-list', args: ['HEAD;rm -rf /'] }, CWD).ok).toBe(false);
    expect(planGitRead({ subcommand: 'merge-base', args: ['HEAD', '$(id)'] }, CWD).ok).toBe(false);
  });
});

describe('git_read handler (#4058 live repo)', () => {
  let repo: string;
  const signal = new AbortController().signal;
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, stdio: 'ignore' }); };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-read-4058-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'b.txt'), 'world\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second');
    git('tag', 'v0.1.0');
  });
  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  it('rev-list --count HEAD returns a number', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'rev-list', args: ['--count', 'HEAD'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(Number(String(r.content).trim())).toBe(2);
  });

  it('merge-base returns common ancestor SHA', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'merge-base', args: ['HEAD', 'HEAD~1'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('merge-base --is-ancestor true case is not an error', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'merge-base', args: ['--is-ancestor', 'HEAD~1', 'HEAD'] }, signal);
    expect(r.isError).toBeFalsy();
  });

  it('merge-base --is-ancestor false case returns non-ancestor message', async () => {
    const h = createGitReadHandler(repo);
    // HEAD is not an ancestor of HEAD~1
    const r = await h({ subcommand: 'merge-base', args: ['--is-ancestor', 'HEAD', 'HEAD~1'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('not an ancestor');
  });

  it('reflog show returns entries', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'reflog', args: ['--oneline'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('second');
  });

  it('for-each-ref lists tags', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'for-each-ref', args: ['--format=%(refname:short)', 'refs/tags/'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('v0.1.0');
  });

  it('describe --tags returns tag', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'describe', args: ['--tags', 'HEAD'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('v0.1.0');
  });

  it('shortlog -s -n HEAD summarises authors', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'shortlog', args: ['-s', '-n'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('T');
  });

  it('cat-file -t HEAD returns commit', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'cat-file', args: ['-t', 'HEAD'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content).trim()).toBe('commit');
  });

  it('cat-file -e for absent object returns non-error', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'cat-file', args: ['-e', 'deadbeef1234567890123456789012345678dead'] }, signal);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('object not found');
  });

  it('remote -v lists remotes (may be empty)', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'remote' }, signal);
    // No remotes configured in scratch repo — empty output is fine, not an error.
    expect(r.isError).toBeFalsy();
  });

  it('stash list lists stashes (may be empty)', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'stash' }, signal);
    expect(r.isError).toBeFalsy();
  });

  it('worktree list lists worktrees', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'worktree' }, signal);
    expect(r.isError).toBeFalsy();
    // On Windows, mkdtempSync may return an 8.3 short path (C:\Users\RUNNER~1\...)
    // while `git worktree list` prints the real long forward-slash path.
    // Resolve `repo` to its canonical long path and normalise to forward slashes;
    // compare case-insensitively so win32 drive-letter casing is irrelevant.
    // Never skip on win32 — posix-guard forbids platform-gated tests.
    const canonicalRepo = realpathSync.native(repo).replace(/\\/g, '/');
    const output = String(r.content).replace(/\\/g, '/');
    expect(output.toLowerCase()).toContain(canonicalRepo.toLowerCase());
  });

  it('log --diff-filter=M is accepted (regression)', async () => {
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'log', args: ['--oneline', '--diff-filter=M'] }, signal);
    expect(r.isError).toBeFalsy();
  });

  it('log with ["-n", "5", "--oneline"] returns output (model-typical form)', async () => {
    // This is the exact arg pattern models emit when limiting log output.
    // The count-shorthand normalizer rewrites -n 5 → --max-count=5 before
    // the argv reaches git, so the handler must accept it end-to-end.
    const h = createGitReadHandler(repo);
    const r = await h({ subcommand: 'log', args: ['-n', '5', '--oneline'] }, signal);
    expect(r.isError).toBeFalsy();
    // The scratch repo has 2 commits; both should appear in the output.
    expect(String(r.content)).toContain('second');
    expect(String(r.content)).toContain('first');
  });

  it('write-variant requests never run git and never write', async () => {
    const h = createGitReadHandler(repo);
    // cat-file --batch would be the most dangerous; policy must reject it
    const r = await h({ subcommand: 'cat-file', args: ['--batch'] }, signal);
    expect(r.isError).toBe(true);
  });
});
