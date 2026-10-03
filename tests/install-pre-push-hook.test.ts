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
  return dir;
}

function runInstaller(repoDir: string, env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  // Strip CI from the inherited env so the runner's CI=true does not leak into
  // the child and trigger the installer's early-exit guard, causing tests that
  // expect a hook to be written to fail silently.
  const { CI: _ci, ...base } = process.env;
  const result = spawnSync(process.execPath, [installerPath], {
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

    // Must be executable.
    const stat = fs.statSync(hp);
    // On POSIX: owner execute bit
    expect(stat.mode & 0o111).toBeGreaterThan(0);
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
});
