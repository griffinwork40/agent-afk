/**
 * Tests for scripts/install-pre-push-hook.mjs
 *
 * Creates isolated temp git repos under os.tmpdir() (POSIX guard R2 compliant).
 * No platform-gated tests (R4).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const installerPath = path.join(repoRoot, 'scripts', 'install-pre-push-hook.mjs');

const MARKER = '# installed-by: agent-afk/install-pre-push-hook';

// ── Helpers ────────────────────────────────────────────────────────────────────

function gitCmd(args: string[], cwd?: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeTempRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afk-${name}-`));
  gitCmd(['init', '-q', dir]);
  gitCmd(['-C', dir, 'config', 'user.email', 'test@example.com']);
  gitCmd(['-C', dir, 'config', 'user.name', 'Test User']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(installerPath, path.join(dir, 'scripts', 'install-pre-push-hook.mjs'));
  return dir;
}

function runInstaller(repoDir: string, env: Record<string, string> = {}, installerRoot = repoDir): { stdout: string; stderr: string; code: number } {
  // Strip CI from the inherited env so the runner's CI=true does not leak into
  // the child and trigger the installer's early-exit guard, causing tests that
  // expect a hook to be written to fail silently.
  const { CI: _ci, ...base } = process.env;
  const result = spawnSync(process.execPath, [path.join(installerRoot, 'scripts', 'install-pre-push-hook.mjs')], {
    encoding: 'utf8',
    cwd: repoDir,
    env: { ...base, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? (result.error ? 1 : 0),
  };
}

function hooksDir(repoDir: string): string {
  // For a plain git init, common dir == .git
  return path.join(repoDir, '.git', 'hooks');
}

function hookPath(repoDir: string): string {
  return path.join(hooksDir(repoDir), 'pre-push');
}

// ── Test state ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

beforeEach(() => {
  // Reset collected temp dirs each test so afterEach can clean them up.
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

function tmpRepo(name: string): string {
  const dir = makeTempRepo(name);
  tempDirs.push(dir);
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('install-pre-push-hook', () => {
  it('installs the launcher into a fresh git repo', () => {
    const dir = tmpRepo('fresh');
    const result = runInstaller(dir);

    expect(result.code).toBe(0);
    const hp = hookPath(dir);
    expect(fs.existsSync(hp)).toBe(true);

    const content = fs.readFileSync(hp, 'utf8');
    expect(content).toContain(MARKER);
    expect(content).toContain('#!/bin/sh');
    expect(content).toContain('scripts/git-hooks/pre-push');

    // Executability is verified by the real Git push integration below.
  });


  it('installed launcher delegates during a real local git push', () => {
    const dir = tmpRepo('push-integration');
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-remote-'));
    tempDirs.push(remote);
    gitCmd(['init', '-q', '--bare', remote]);

    fs.mkdirSync(path.join(dir, 'scripts', 'git-hooks'), { recursive: true });
    const sentinel = path.join(dir, 'sentinel.txt');
    fs.writeFileSync(
      path.join(dir, 'scripts', 'git-hooks', 'pre-push'),
      `#!/bin/sh\nprintf '%s\n' delegated > "${sentinel.replace(/\\/g, '/')}"\ncat >/dev/null\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(path.join(dir, 'scripts', 'git-hooks', 'pre-push'), 0o755);
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    gitCmd(['-C', dir, 'add', 'README.md', 'scripts/git-hooks/pre-push']);
    gitCmd(['-C', dir, 'commit', '-qm', 'init']);
    gitCmd(['-C', dir, 'remote', 'add', 'origin', remote]);

    const install = runInstaller(dir);
    expect(install.code).toBe(0);

    const push = spawnSync('git', ['-C', dir, 'push', '-u', 'origin', 'HEAD:main'], { encoding: 'utf8' });
    expect(push.status, push.stderr + push.stdout).toBe(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('delegated\n');
  });

  it('is idempotent — running twice produces identical content and exits 0', () => {
    const dir = tmpRepo('idempotent');

    const r1 = runInstaller(dir);
    expect(r1.code).toBe(0);

    const content1 = fs.readFileSync(hookPath(dir), 'utf8');

    const r2 = runInstaller(dir);
    expect(r2.code).toBe(0);

    const content2 = fs.readFileSync(hookPath(dir), 'utf8');
    expect(content2).toBe(content1);
  });

  it('refuses to overwrite a foreign pre-push hook (no marker)', () => {
    const dir = tmpRepo('foreign');
    const hp = hookPath(dir);

    // Write a foreign hook without the marker.
    fs.mkdirSync(hooksDir(dir), { recursive: true });
    fs.writeFileSync(hp, '#!/bin/sh\necho "custom hook"\n', 'utf8');
    fs.chmodSync(hp, 0o755);

    const result = runInstaller(dir, {});

    // Installer exits 0 (fail-open) but warns.
    expect(result.code).toBe(0);

    // Content must NOT have been overwritten.
    const content = fs.readFileSync(hp, 'utf8');
    expect(content).not.toContain(MARKER);
    expect(content).toContain('custom hook');

    // Must have emitted a warning.
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not overwriting|already exists/i);
  });

  it('skips installation when CI env var is set', () => {
    const dir = tmpRepo('ci-skip');

    const result = runInstaller(dir, { CI: 'true' });
    expect(result.code).toBe(0);

    // Hook must NOT have been written.
    expect(fs.existsSync(hookPath(dir))).toBe(false);
  });

  it('installs into the common hooks dir from a linked worktree subdirectory', () => {
    const dir = tmpRepo('linked');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    gitCmd(['-C', dir, 'add', 'README.md']);
    gitCmd(['-C', dir, 'commit', '-qm', 'init']);
    const linked = `${dir}-wt`;
    tempDirs.push(linked);
    gitCmd(['-C', dir, 'worktree', 'add', '-q', linked, '-b', 'topic']);
    fs.mkdirSync(path.join(linked, 'scripts'), { recursive: true });
    fs.copyFileSync(installerPath, path.join(linked, 'scripts', 'install-pre-push-hook.mjs'));
    const nested = path.join(linked, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });

    const result = runInstaller(nested, {}, linked);
    expect(result.code).toBe(0);
    expect(fs.existsSync(hookPath(dir))).toBe(true);
    expect(fs.existsSync(path.join(linked, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('skips with warning when effective core.hooksPath is configured', () => {
    const dir = tmpRepo('hooks-path');
    gitCmd(['-C', dir, 'config', 'core.hooksPath', '.githooks']);

    const result = runInstaller(dir);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain('core.hooksPath is configured');
    expect(fs.existsSync(hookPath(dir))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.githooks', 'pre-push'))).toBe(false);
  });

  it('does not let a nested consumer package write ancestor repo hooks', () => {
    const outer = tmpRepo('outer');
    const consumer = path.join(outer, 'node_modules', 'agent-afk');
    fs.mkdirSync(path.dirname(consumer), { recursive: true });
    fs.mkdirSync(path.join(consumer, 'scripts'), { recursive: true });
    fs.copyFileSync(installerPath, path.join(consumer, 'scripts', 'install-pre-push-hook.mjs'));

    const result = runInstaller(consumer, {}, consumer);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain('nested under a different git toplevel');
    expect(fs.existsSync(hookPath(outer))).toBe(false);
  });
});
