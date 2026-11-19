import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveShell } from '../src/utils/resolve-shell.js';
import { rmSyncRetry } from '../src/__test-utils__/rm-sync-retry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repoRoot, 'scripts', 'git-hooks', 'pre-push');
const zero = '0000000000000000000000000000000000000000';

function shellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Invariant: On Windows CI (github windows-2022), git is at
 * C:\Program Files\Git\cmd\git.exe and `git --exec-path` returns something like
 * C:\Program Files\Git\mingw64\libexec\git-core. bash.exe lives at
 * C:\Program Files\Git\bin\bash.exe — reachable via ../../bin/bash.exe or
 * ../../../bin/bash.exe relative to the exec-path. This avoids any platform-gated
 * skip (R4) while still locating a POSIX shell on Windows.
 */
function findBashViaGit(): string | undefined {
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    for (const rel of ['../../bin/bash.exe', '../../../bin/bash.exe']) {
      const candidate = path.resolve(execPath, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // git not available or exec-path failed
  }
  try {
    // Derive from `where git` (Windows only — safe to call, throws on non-Windows)
    const gitWhere = execFileSync('where', ['git'], { encoding: 'utf8' }).trim().split('\n')[0]?.trim();
    if (gitWhere) {
      const gitDir = path.dirname(gitWhere);
      for (const rel of ['../bin/bash.exe', '../../bin/bash.exe']) {
        const candidate = path.resolve(gitDir, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // `where` is not available on non-Windows — ignore
  }
  return undefined;
}

function shellCommandArgs(command: string): { command: string; args: string[] } {
  const shell = resolveShell();
  if (shell.shell === true) return { command: 'sh', args: ['-c', command] };
  if (shell.shell.toLowerCase().endsWith('bash.exe') || shell.shell.toLowerCase().endsWith('/bash')) {
    return { command: shell.shell, args: [...(shell.args ?? ['-c']), command] };
  }
  // resolveShell() returned PowerShell — try harder to find bash via git --exec-path
  const bash = findBashViaGit();
  if (bash !== undefined) {
    return { command: bash, args: ['-c', command] };
  }
  // No POSIX shell found — this should not happen on CI (Git Bash is always available)
  throw new Error(
    'pre-push hook tests require a POSIX shell; Git Bash was not found. ' +
      'Install Git for Windows or run with Git Bash.',
  );
}

function runHook(
  stdin: string,
  options: {
    pkg?: Record<string, unknown>; pnpmExit?: number; omitNodeModules?: boolean;
    setup?: (dir: string) => string; override?: string;
  } = {},
): SpawnSyncReturns<string> & { dir: string; pnpmLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pre-push-'));
  const pnpmLog = path.join(dir, 'pnpm.log');
  try {
    spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(options.pkg ?? { scripts: { 'check:audits': 'echo ok' } }), 'utf8');
    if (!options.omitNodeModules) {
      fs.mkdirSync(path.join(dir, 'node_modules'));
    }
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$@" >> "${shellPath(pnpmLog)}"\nexit \${PNPM_EXIT:-0}\n`, 'utf8');
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
    const cmd = shellCommandArgs(`AFK_ALLOW_MAIN_PUSH='${options.override ?? ''}' "${shellPath(hook)}"`);
    const result = spawnSync(cmd.command, cmd.args, {
      cwd: dir,
      input: options.setup?.(dir) ?? stdin,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PNPM_EXIT: String(options.pnpmExit ?? 0) },
    });
    return Object.assign(result, { dir, pnpmLog });
  } catch (err) {
    // rmSyncRetry: git may still be writing objects when the hook process exits.
    // Best-effort: a permanently locked dir (e.g. Windows AV hold) must not
    // swallow the original error (finding #3208).
    try { rmSyncRetry(dir); } catch { /* best-effort — locked dir on CI */ }
    throw err;
  }
}

function cleanup(result: { dir: string }): void {
  // rmSyncRetry: git may still be writing objects into .git/ when the test
  // finishes, causing ENOTEMPTY on CI. Retries let in-flight writes settle.
  // Best-effort: a permanently locked dir (e.g. Windows AV hold) must not
  // abort remaining cleanup (finding #3208).
  try { rmSyncRetry(result.dir); } catch { /* best-effort — locked dir on CI */ }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=AFK Agent', '-c', 'user.email=agent@agentafk.com', ...args], { encoding: 'utf8' }).trim();
}

function commit(dir: string, subject: string): string {
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', subject);
  return git(dir, 'rev-parse', 'HEAD');
}

function mainUpdate(local: string, remote: string): string {
  return `refs/heads/release ${local} refs/heads/main ${remote}\r\n`;
}

const refusal = 'pre-push: refusing direct push to main; open a PR instead. Only chore(release): or docs(changelog): commits are allowed. Human override: AFK_ALLOW_MAIN_PUSH=1 git push';

describe('direct main push guard', () => {
  it.each([
    ['chore(release): v1', 'docs(changelog): prep', 0],
    ['fix: accidental direct push', 'chore(release): v1', 1],
    ['chore(release): v1', 'fix: trailing change', 1],
    ['prefix chore(release): v1', 'docs(changelog): prep', 1],
  ] as const)('checks the entire range: %s / %s', (first, last, status) => {
    const result = runHook('', { setup(dir) {
      const base = commit(dir, 'feat: already on remote');
      commit(dir, first);
      const tip = commit(dir, last);
      // A release's tag ref is not subject to the main guard.
      return mainUpdate(tip, base) + `refs/tags/v1 ${tip} refs/tags/v1 ${zero}\n`;
    } });
    try {
      expect(result.status).toBe(status);
      if (status) expect(result.stderr).toContain(refusal);
      expect(fs.existsSync(result.pnpmLog)).toBe(status === 0);
    } finally { cleanup(result); }
  });

  it.each(['chore(release): initial', 'feat: initial'])('checks all history for new remote main: %s', (subject) => {
    const result = runHook('', { setup: (dir) => mainUpdate(commit(dir, subject), zero) });
    try { expect(result.status).toBe(subject.startsWith('chore(release):') ? 0 : 1); }
    finally { cleanup(result); }
  });

  it.each(['', '0', 'true', '1'])('only explicit override 1 bypasses the guard: %j', (override) => {
    const result = runHook('', { override, setup: (dir) => mainUpdate(commit(dir, 'fix: direct'), zero) });
    try {
      expect(result.status).toBe(override === '1' ? 0 : 1);
      expect(fs.existsSync(result.pnpmLog)).toBe(override === '1');
    } finally { cleanup(result); }
  });

  it('enforces main guard before the missing-dependencies fail-open', () => {
    const result = runHook('', { omitNodeModules: true, setup: (dir) => mainUpdate(commit(dir, 'fix: direct'), zero) });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(refusal);
      expect(result.stderr).not.toContain('skipping audit gates');
    } finally { cleanup(result); }
  });

  it('refuses when the remote range cannot be inspected', () => {
    const result = runHook('', { setup: (dir) => mainUpdate(commit(dir, 'chore(release): v1'), 'f'.repeat(40)) });
    try { expect(result.status).toBe(1); expect(result.stderr).toContain(refusal); }
    finally { cleanup(result); }
  });

  it.each([
    ['docs(changelog): side', 'chore(release): merge', 0],
    ['fix: hidden on second parent', 'chore(release): merge', 1],
    ['docs(changelog): side', 'Merge branch side', 1],
  ] as const)('checks merge subjects and second-parent commits: %s / %s', (side, merge, status) => {
    const result = runHook('', { setup(dir) {
      const base = commit(dir, 'feat: already on remote');
      git(dir, 'checkout', '-qb', 'side');
      commit(dir, side);
      git(dir, 'checkout', '-qb', 'release', base);
      commit(dir, 'docs(changelog): prep');
      git(dir, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-qm', merge, 'side');
      return mainUpdate(git(dir, 'rev-parse', 'HEAD'), base);
    } });
    try { expect(result.status).toBe(status); }
    finally { cleanup(result); }
  });

  it('does not restrict new tags or other branches', () => {
    const result = runHook('', { setup(dir) {
      const tip = commit(dir, 'feat: anything');
      return `refs/heads/feature ${tip} refs/heads/feature ${zero}\nrefs/tags/v1 ${tip} refs/tags/v1 ${zero}\n`;
    } });
    try { expect(result.status).toBe(0); expect(fs.existsSync(result.pnpmLog)).toBe(true); }
    finally { cleanup(result); }
  });
});

describe('scripts/git-hooks/pre-push', () => {
  it('skips deletion-only pushes using Git stdin field order', () => {
    const result = runHook(`(delete) ${zero} refs/heads/main abcdef\n`);
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('running pnpm check:audits');
      expect(fs.existsSync(result.pnpmLog)).toBe(false);
    } finally {
      cleanup(result);
    }
  });

  it('runs audits for mixed deletion and update pushes', () => {
    const result = runHook(`(delete) ${zero} refs/heads/old abcdef\nrefs/heads/feature abcdef refs/heads/feature 123456\n`);
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('running pnpm check:audits');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('skips empty input and CRLF deletion input', () => {
    const empty = runHook('');
    try {
      expect(empty.status).toBe(0);
      expect(fs.existsSync(empty.pnpmLog)).toBe(false);
    } finally {
      cleanup(empty);
    }

    const crlf = runHook(`(delete) ${zero} refs/heads/main abcdef\r\n`);
    try {
      expect(crlf.status).toBe(0);
      expect(crlf.stderr).not.toContain('running pnpm check:audits');
      expect(fs.existsSync(crlf.pnpmLog)).toBe(false);
    } finally {
      cleanup(crlf);
    }
  });

  it('fails open when check:audits is absent', () => {
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { pkg: { scripts: {} } });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('lacks scripts.check:audits');
      expect(fs.existsSync(result.pnpmLog)).toBe(false);
    } finally {
      cleanup(result);
    }
  });

  it('passes when check:audits exits 0', () => {
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { pnpmExit: 0 });
    try {
      expect(result.status).toBe(0);
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('blocks when check:audits exits 1', () => {
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { pnpmExit: 1 });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CI will fail these checks');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('fails open when check:audits exits 2', () => {
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { pnpmExit: 2 });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('environment may be broken');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('log.showSignature=true in repo config does not cause false refusal of a chore(release): push to main', () => {
    // History: regression guard for the log.showSignature bug reported in the
    // Codex review thread on scripts/git-hooks/pre-push line 37.
    // With log.showSignature=true, git writes signature-verification output
    // (e.g. "No signature") to stdout before each %H %s record.  Without
    // --no-show-signature the loop reads that line as a subject, the *) arm
    // calls refuse_main, and a valid chore(release): push is incorrectly
    // refused.  The fix adds -c log.showSignature=false and
    // --no-show-signature so the machine-parsed git log is immune to that
    // config regardless of which flag the installed git version honours.
    //
    // We write a commit object by hand (git hash-object -t commit -w --stdin)
    // carrying a gpgsig header that contains a minimal SSH signature armor
    // block.  git reports on gpgsig headers even when no key material is
    // present, triggering the showSignature output without needing ssh-keygen
    // or any pre-existing key on the runner.
    const result = runHook('', { setup(dir) {
      // Establish a base commit already "on remote".
      const base = commit(dir, 'feat: already on remote');

      // Enable log.showSignature in the repo so git log pollutes stdout.
      git(dir, 'config', 'log.showSignature', 'true');

      // Build a raw commit object with a gpgsig header.  git hash-object
      // accepts the binary commit format on stdin and writes it to the
      // object store.  The gpgsig value is an SSH armor block; it need not
      // be cryptographically valid — git reports "No signature" / parse
      // errors to stdout either way, which is what triggers the bug.
      const treeHash = git(dir, 'rev-parse', `${base}^{tree}`);
      const authorLine = 'author AFK Agent <agent@agentafk.com> 1700000000 +0000';
      const committerLine = 'committer AFK Agent <agent@agentafk.com> 1700000000 +0000';
      const subject = 'chore(release): v99';
      // Minimal SSH signature armor (not cryptographically valid — only the
      // header/footer matter for git's showSignature output path).
      const sigArmor = [
        '-----BEGIN SSH SIGNATURE-----',
        'AAAAB3NzaC1yc2EAAAADAQABAAAAgQC0FAKE==',
        '-----END SSH SIGNATURE-----',
      ].join('\n');
      // gpgsig value lines after the first must be space-indented per the
      // git commit-object format.
      const gpgsigLines = sigArmor.split('\n').join('\n ');
      const rawCommit = [
        `tree ${treeHash}`,
        `parent ${base}`,
        authorLine,
        committerLine,
        `gpgsig ${gpgsigLines}`,
        '',
        subject,
        '',
      ].join('\n');

      const signedSha = execFileSync(
        'git',
        ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin'],
        { input: rawCommit, encoding: 'utf8' },
      ).trim();

      // Point HEAD at the hand-crafted commit.
      git(dir, 'update-ref', 'HEAD', signedSha);

      return mainUpdate(signedSha, base);
    } });
    try {
      // The push must succeed (exit 0): the hook must not refuse a
      // chore(release): commit just because log.showSignature is set.
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain(refusal);
    } finally { cleanup(result); }
  });

  it('blocks when check:audits exits with a signal code >= 3', () => {
    // pnpm terminated by a signal (or any non-zero exit >= 3 that is not the
    // "all gates broken" sentinel of 2) must still block the push — exit 1.
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { pnpmExit: 3 });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CI will fail these checks');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('fails open when node_modules is absent', () => {
    // Fail-open: when node_modules is missing the hook must exit 0 (never block).
    const result = runHook('refs/heads/feature abcdef refs/heads/feature 123456\n', { omitNodeModules: true });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('node_modules not found');
      expect(fs.existsSync(result.pnpmLog)).toBe(false);
    } finally {
      cleanup(result);
    }
  });
});
