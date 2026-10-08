/**
 * Tests for the glob walker's canonical-path denylist check and abort
 * handling (#2543).
 *
 * The walker derives each non-symlink child's canonical path from its parent
 * instead of calling realpathSync per entry. These tests pin that the verdicts
 * stay identical to `isReadDenied`, especially through symlinks, where a
 * derived path would be wrong and fail open.
 *
 * Run with: pnpm test src/agent/tools/handlers/glob-canonical.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createGlobHandler } from './glob.js';
import {
  _resetReadDenylistCacheForTests,
  isCanonicalPathReadDenied,
  isReadDenied,
} from './read-denylist.js';
import { safeRealpath } from './write-denylist.js';

const signal = (): AbortSignal => new AbortController().signal;

describe('glob walker: canonical-path denylist (#2543)', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-canon-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-canon-out-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetReadDenylistCacheForTests();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function denyRoots(...roots: string[]): void {
    vi.stubEnv('AFK_READ_DENYLIST', roots.join(','));
    _resetReadDenylistCacheForTests();
  }

  it('isCanonicalPathReadDenied matches isReadDenied for canonical input', async () => {
    const secret = path.join(root, 'secret');
    await fs.mkdir(secret);
    await fs.writeFile(path.join(secret, 'k.ts'), '');
    await fs.writeFile(path.join(root, 'ok.ts'), '');
    denyRoots(secret);

    for (const p of [path.join(secret, 'k.ts'), path.join(root, 'ok.ts'), secret, root]) {
      expect(isCanonicalPathReadDenied(safeRealpath(p))).toEqual(isReadDenied(p));
    }
  });

  it('still denies a symlinked FILE whose target is inside a denied root', async () => {
    const secret = path.join(outside, 'secret');
    await fs.mkdir(secret);
    await fs.writeFile(path.join(secret, 'token.ts'), 'x');
    await fs.symlink(path.join(secret, 'token.ts'), path.join(root, 'innocent.ts'));
    await fs.writeFile(path.join(root, 'visible.ts'), '');
    denyRoots(secret);

    const result = await createGlobHandler(root)({ pattern: '*.ts' }, signal());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('visible.ts');
    expect(result.content).not.toContain('innocent.ts');
  });

  it('still denies a symlinked DIRECTORY entry pointing into a denied root', async () => {
    const secret = path.join(outside, 'secret');
    await fs.mkdir(secret);
    await fs.symlink(secret, path.join(root, 'shortcut'));
    denyRoots(secret);

    const result = await createGlobHandler(root)({ pattern: '*' }, signal());

    expect(result.content).not.toContain('shortcut');
  });

  it('denies descendants when the search root itself is reached through a symlink', async () => {
    // The walker's logical path (via the link) differs from the canonical one;
    // denial must be computed on the canonical side.
    const real = path.join(outside, 'real');
    await fs.mkdir(path.join(real, 'secret'), { recursive: true });
    await fs.writeFile(path.join(real, 'secret', 'k.ts'), '');
    await fs.writeFile(path.join(real, 'ok.ts'), '');
    const link = path.join(root, 'link');
    await fs.symlink(real, link);
    denyRoots(path.join(real, 'secret'));

    const result = await createGlobHandler(link)({ pattern: '**/*.ts' }, signal());

    expect(result.isError).toBeUndefined();
    expect(result.content.split('\n')).toEqual(['ok.ts']);
  });

  it('keeps listing non-denied symlink entries (the walker does not follow them)', async () => {
    await fs.writeFile(path.join(root, 'target.md'), '');
    await fs.symlink(path.join(root, 'target.md'), path.join(root, 'alias.md'));

    const result = await createGlobHandler(root)({ pattern: '*.md' }, signal());

    expect(result.content).toContain('alias.md');
    expect(result.content).toContain('target.md');
  });

  it('hardlink into denied directory is visible (hardlinks are not covered by the denylist contract)', async () => {
    // A hardlink shares an inode with the original file but appears under an
    // ordinary filename — Dirent.isSymbolicLink() returns false, so the walker
    // takes the canonical-path fast path (join(realPath, name)).  That derived
    // path is inside `root`, not inside `secret`, so the denylist cannot catch
    // it.  This test pins the known behavior: hardlinks into denied directories
    // are NOT blocked by the current implementation.  If the contract ever
    // expands to cover hardlinks (e.g. via inode comparison), update this test.
    const secret = path.join(outside, 'secret');
    await fs.mkdir(secret);
    const original = path.join(secret, 'private.ts');
    await fs.writeFile(original, 'secret');
    // Create a hardlink inside `root` pointing to the same inode.
    const hardlink = path.join(root, 'hardlink.ts');
    await fs.link(original, hardlink);
    denyRoots(secret);

    const result = await createGlobHandler(root)({ pattern: '*.ts' }, signal());

    // The hardlink appears under root/ and is not blocked — document this.
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hardlink.ts');
  });
});

describe('glob walker: abort signal (#2543)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-abort-'));
    for (let i = 0; i < 20; i++) {
      await fs.mkdir(path.join(root, `d${i}`, 'nested'), { recursive: true });
      await fs.writeFile(path.join(root, `d${i}`, 'nested', 'f.ts'), '');
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns "Search aborted" when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await createGlobHandler(root)({ pattern: '**/*.ts' }, ac.signal);

    expect(result).toEqual({ content: 'Search aborted', isError: true });
  });

  it('stops a walk that is aborted mid-flight', async () => {
    const ac = new AbortController();
    const pending = createGlobHandler(root)({ pattern: '**/*.ts' }, ac.signal);
    ac.abort();

    const result = await pending;

    expect(result).toEqual({ content: 'Search aborted', isError: true });
  });

  it('completes normally with a live signal', async () => {
    const result = await createGlobHandler(root)({ pattern: '**/*.ts' }, signal());

    expect(result.isError).toBeUndefined();
    expect(result.content.split('\n')).toHaveLength(20);
  });
});
