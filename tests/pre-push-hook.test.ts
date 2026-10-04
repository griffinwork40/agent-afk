import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveShell } from '../src/utils/resolve-shell.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repoRoot, 'scripts', 'git-hooks', 'pre-push');
const zero = '0000000000000000000000000000000000000000';

function shellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function shellCommandArgs(command: string): { command: string; args: string[] } {
  const shell = resolveShell();
  if (shell.shell === true) return { command: 'sh', args: ['-c', command] };
  if (shell.shell.toLowerCase().endsWith('bash.exe') || shell.shell.toLowerCase().endsWith('/bash')) {
    return { command: shell.shell, args: [...(shell.args ?? ['-c']), command] };
  }
  throw new Error('pre-push hook tests require a POSIX shell; Git Bash was not found on Windows');
}

function runHook(
  stdin: string,
  options: { pkg?: Record<string, unknown>; pnpmExit?: number } = {},
): SpawnSyncReturns<string> & { dir: string; pnpmLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pre-push-'));
  const pnpmLog = path.join(dir, 'pnpm.log');
  try {
    spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(options.pkg ?? { scripts: { 'check:audits': 'echo ok' } }), 'utf8');
    fs.mkdirSync(path.join(dir, 'node_modules'));
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
});
