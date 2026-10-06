import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveShell } from '../src/utils/resolve-shell.js';

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
  options: { pkg?: Record<string, unknown>; pnpmExit?: number; omitNodeModules?: boolean } = {},
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
    const cmd = shellCommandArgs(`"${shellPath(hook)}"`);
    const result = spawnSync(cmd.command, cmd.args, {
      cwd: dir,
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PNPM_EXIT: String(options.pnpmExit ?? 0) },
    });
    return Object.assign(result, { dir, pnpmLog });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function cleanup(result: { dir: string }): void {
  fs.rmSync(result.dir, { recursive: true, force: true });
}

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
    const result = runHook(`(delete) ${zero} refs/heads/old abcdef\nrefs/heads/main abcdef refs/heads/main 123456\n`);
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
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { pkg: { scripts: {} } });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('lacks scripts.check:audits');
      expect(fs.existsSync(result.pnpmLog)).toBe(false);
    } finally {
      cleanup(result);
    }
  });

  it('passes when check:audits exits 0', () => {
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { pnpmExit: 0 });
    try {
      expect(result.status).toBe(0);
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('blocks when check:audits exits 1', () => {
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { pnpmExit: 1 });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CI will fail these checks');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('fails open when check:audits exits 2', () => {
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { pnpmExit: 2 });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('environment may be broken');
      expect(fs.readFileSync(result.pnpmLog, 'utf8')).toBe('check:audits\n');
    } finally {
      cleanup(result);
    }
  });

  it('blocks when check:audits exits with a signal code >= 3', () => {
    // pnpm terminated by a signal (or any non-zero exit >= 3 that is not the
    // "all gates broken" sentinel of 2) must still block the push — exit 1.
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { pnpmExit: 3 });
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
    const result = runHook('refs/heads/main abcdef refs/heads/main 123456\n', { omitNodeModules: true });
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('node_modules not found');
      expect(fs.existsSync(result.pnpmLog)).toBe(false);
    } finally {
      cleanup(result);
    }
  });
});
