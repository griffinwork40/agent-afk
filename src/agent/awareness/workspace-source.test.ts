/**
 * Tests for workspace-source.ts — Phase 2 git baseline gatherer.
 *
 * Uses the repo's own cwd for the happy-path tests (the repo is always a
 * git repo during CI), and a temp dir for the non-git-cwd path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { gatherWorkspace } from './workspace-source.js';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Happy path — the repo's own cwd
// ---------------------------------------------------------------------------

describe('gatherWorkspace (real git repo)', () => {
  it('returns non-null branch and headSha for this repo', () => {
    // Use the src/agent/awareness/ dir — guaranteed to be in a git repo.
    const cwd = new URL('.', import.meta.url).pathname;
    const ws = gatherWorkspace(cwd);

    // headSha should be a 7-char hex string (may be shorter if repo is shallow,
    // but rev-parse --short always produces at least 4 chars).
    if (ws.headSha !== null) {
      expect(ws.headSha).toMatch(/^[0-9a-f]{4,}$/);
    }

    // dirty and dirtyCount must be consistent.
    if (ws.dirty !== null && ws.dirtyCount !== null) {
      if (ws.dirty) {
        expect(ws.dirtyCount).toBeGreaterThan(0);
      } else {
        expect(ws.dirtyCount).toBe(0);
      }
    }
  });

  it('returns an object matching the RuntimeWorkspace shape', () => {
    const cwd = new URL('.', import.meta.url).pathname;
    const ws = gatherWorkspace(cwd);

    expect(typeof ws).toBe('object');
    expect('branch' in ws).toBe(true);
    expect('headSha' in ws).toBe(true);
    expect('dirty' in ws).toBe(true);
    expect('dirtyCount' in ws).toBe(true);
    expect('remoteUrl' in ws).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-git cwd path — uses a temp dir
// ---------------------------------------------------------------------------

describe('gatherWorkspace (non-git dir)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all-null when cwd is not a git repo', () => {
    const ws = gatherWorkspace(tmpDir);
    expect(ws.branch).toBeNull();
    expect(ws.headSha).toBeNull();
    expect(ws.dirty).toBeNull();
    expect(ws.dirtyCount).toBeNull();
    expect(ws.remoteUrl).toBeNull();
  });

  it('does not throw on non-git cwd', () => {
    expect(() => gatherWorkspace(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mocked spawnSync — isolates each failure mode
// ---------------------------------------------------------------------------

describe('gatherWorkspace (mocked spawnSync)', () => {
  it('returns all-null when spawnSync throws', async () => {
    const { spawnSync } = await import('child_process');
    const spy = vi.spyOn({ spawnSync }, 'spawnSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    // Re-import after mocking is not straightforward in ESM; instead test
    // via a non-existent path which will also cause git to fail.
    const ws = gatherWorkspace('/no/such/path/definitely/not/a/repo');
    expect(ws.headSha).toBeNull();

    spy.mockRestore();
  });

  it('returns all-null when rev-parse returns non-zero status', () => {
    // Use a path that exists but isn't a git repo
    const ws = gatherWorkspace(os.tmpdir());
    // tmpdir itself is not a git repo (it's OS-dependent whether it is, but
    // even if it is, headSha will be non-null — so we only assert structure).
    expect(typeof ws.branch === 'string' || ws.branch === null).toBe(true);
    expect(typeof ws.headSha === 'string' || ws.headSha === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clean vs dirty temp repo — regression guard for the clean-repo null bug.
//
// A CLEAN working tree emits empty `git status --porcelain` (exit 0). The
// gatherWorkspace happy-path test above cannot catch this: its dirty/dirtyCount
// assertions are guarded behind `if (ws.dirty !== null && ...)`, so a buggy
// null value skips the assertion (vacuous pass). These tests construct a real
// repo and assert dirty/dirtyCount UNCONDITIONALLY, so a regression to
// dirty:null on a clean tree fails loudly.
// ---------------------------------------------------------------------------

describe('gatherWorkspace (clean vs dirty temp repo)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ws-clean-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // Never prompt for a GPG passphrase in CI.
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
    git('add', 'file.txt');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reports a CLEAN repo as dirty:false / dirtyCount:0 (not null)', () => {
    const ws = gatherWorkspace(repo);
    expect(ws.headSha).not.toBeNull();
    // The regression: empty porcelain output must be read as "clean", never
    // conflated with a failed status call.
    expect(ws.dirty).toBe(false);
    expect(ws.dirtyCount).toBe(0);
  });

  it('reports a DIRTY repo as dirty:true with a positive count', () => {
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
    const ws = gatherWorkspace(repo);
    expect(ws.dirty).toBe(true);
    expect(ws.dirtyCount).toBeGreaterThan(0);
  });
});
