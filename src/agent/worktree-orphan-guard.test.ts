import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOrphanDir } from './worktree-orphan-guard.js';

const HOUR_MS = 3_600_000;
const AGED_MS = HOUR_MS * 2;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'afk-orphan-guard-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('classifyOrphanDir — age gate', () => {
  it('preserves an orphan younger than the age gate (an in-flight worktree add)', async () => {
    await writeFile(join(root, '.env'), 'SECRET=1');
    const verdict = await classifyOrphanDir(root, 5_000, HOUR_MS);
    expect(verdict).toEqual({
      remove: false,
      because: 'too-young',
      detail: 'age 5000ms < 3600000ms',
    });
  });

  it('preserves when the caller could not stat the directory (age 0)', async () => {
    // Contract: a failed stat must pass 0, which the age gate refuses — it must
    // never read as "infinitely old" and authorise a delete.
    const verdict = await classifyOrphanDir(root, 0, HOUR_MS);
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) expect(verdict.because).toBe('too-young');
  });

  it('preserves on a non-finite age rather than trusting the comparison', async () => {
    const verdict = await classifyOrphanDir(root, Number.NaN, HOUR_MS);
    expect(verdict.remove).toBe(false);
  });
});

describe('classifyOrphanDir — content probe', () => {
  it('preserves an aged orphan holding a non-rebuildable ignored file', async () => {
    await writeFile(join(root, '.env'), 'TOKEN=abc');
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS);
    expect(verdict).toEqual({
      remove: false,
      because: 'non-rebuildable-content',
      detail: '.env',
    });
  });

  it('preserves an aged orphan holding an untracked source file', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS);
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) {
      expect(verdict.because).toBe('non-rebuildable-content');
      expect(verdict.detail).toBe('src/index.ts');
    }
  });

  it('preserves a secret nested under a build-output directory', async () => {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'prod.env'), 'K=v');
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS);
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) expect(verdict.because).toBe('non-rebuildable-content');
  });

  it('removes an aged, genuinely empty orphan', async () => {
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS);
    expect(verdict).toEqual({ remove: true });
  });

  it('removes an aged orphan whose only content is a dependency tree', async () => {
    // The sweep must still reclaim the common case — a failed `worktree add`
    // that got as far as installing deps — or the guard defeats its purpose.
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;');
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS);
    expect(verdict).toEqual({ remove: true });
  });
});

describe('classifyOrphanDir — failure and bounds', () => {
  it('preserves when the directory cannot be read', async () => {
    const verdict = await classifyOrphanDir(join(root, 'does-not-exist'), AGED_MS, HOUR_MS);
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) expect(verdict.because).toBe('scan-failed');
  });

  it('preserves when the walk outgrows its entry budget', async () => {
    await mkdir(join(root, 'build'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      await writeFile(join(root, 'build', `chunk-${i}.js`), '0');
    }
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS, { maxEntries: 2 });
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) expect(verdict.because).toBe('scan-budget-exhausted');
  });

  it('preserves rather than descending past the depth bound', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    const verdict = await classifyOrphanDir(root, AGED_MS, HOUR_MS, { maxDepth: 1 });
    expect(verdict.remove).toBe(false);
    if (!verdict.remove) expect(verdict.because).toBe('scan-failed');
  });

  it('never throws on a path that is a file rather than a directory', async () => {
    const filePath = join(root, 'plain.txt');
    await writeFile(filePath, 'x');
    const verdict = await classifyOrphanDir(filePath, AGED_MS, HOUR_MS);
    expect(verdict.remove).toBe(false);
  });
});
