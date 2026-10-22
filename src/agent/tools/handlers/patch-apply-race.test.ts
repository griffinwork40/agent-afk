import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPatchApplyHandler } from './patch-apply.js';
import { _setRealScratchRootsForTests, _resetScratchRootsCacheForTests } from './scratch-roots.js';

const roots: string[] = [];
afterEach(async () => {
  _resetScratchRootsCacheForTests();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'patch-checkpoint-race-'));
  roots.push(root);
  const allowed = join(root, 'allowed');
  const dir = join(allowed, 'dir');
  const outside = join(root, 'outside');
  await mkdir(dir, { recursive: true });
  await mkdir(outside);
  await writeFile(join(dir, 'a.ts'), 'old');
  await writeFile(join(allowed, 'other.ts'), 'other');
  await writeFile(join(outside, 'a.ts'), 'SECRET');
  _setRealScratchRootsForTests([]);
  return { root, allowed, dir, outside };
}

describe('patch checkpoint race guards', () => {
  it('allows unchanged checkpoints and creation under missing parent directories', async () => {
    const { allowed, dir } = await setup();
    const result = await createPatchApplyHandler(allowed)({ changes: [
      { path: 'dir/a.ts', content: 'new' }, { path: 'missing/nested/new.ts', content: 'created' },
    ] }, new AbortController().signal, {
      resolveBase: allowed, writeRoots: [allowed],
      fileCheckpoint: { turnId: 'test', touchedPaths: () => [], snapshotFile: async () => {} },
    });
    expect(JSON.parse(result.content as string).status).toBe('applied');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('new');
    expect(await readFile(join(allowed, 'missing/nested/new.ts'), 'utf8')).toBe('created');
  });

  it('rejects parent symlink swaps without writing outside or touching other patch targets', async () => {
    const { allowed, dir, outside } = await setup();
    let swapped = false;
    const result = await createPatchApplyHandler(allowed)({ changes: [
      { path: 'other.ts', content: 'changed' }, { path: 'dir/a.ts', content: 'new' },
    ] }, new AbortController().signal, {
      resolveBase: allowed, writeRoots: [allowed],
      fileCheckpoint: { turnId: 'test', touchedPaths: () => [], snapshotFile: async () => {
        if (swapped) return;
        swapped = true;
        await rename(dir, `${dir}-saved`);
        await symlink(outside, dir, 'dir');
      } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content as string).status).toBe('validation_failed');
    expect(await readFile(join(outside, 'a.ts'), 'utf8')).toBe('SECRET');
    expect(await readFile(join(allowed, 'other.ts'), 'utf8')).toBe('other');
    expect(await readFile(join(`${dir}-saved`, 'a.ts'), 'utf8')).toBe('old');
    expect(await readdir(outside)).toEqual(['a.ts']);
  });

  it('rejects changed content during checkpoint even without caller expected_hash', async () => {
    const { allowed, dir } = await setup();
    const result = await createPatchApplyHandler(allowed)({ changes: [
      { path: 'other.ts', content: 'changed' }, { path: 'dir/a.ts', content: 'new' },
    ] }, new AbortController().signal, {
      resolveBase: allowed, writeRoots: [allowed],
      fileCheckpoint: { turnId: 'test', touchedPaths: () => [], snapshotFile: async () => {
        await writeFile(join(dir, 'a.ts'), 'external update');
      } },
    });
    const body = JSON.parse(result.content as string);
    expect(body.status).toBe('validation_failed');
    expect(body.errors[0].error).toBe('hash_mismatch');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('external update');
    expect(await readFile(join(allowed, 'other.ts'), 'utf8')).toBe('other');
  });

  it('rejects a same-content parent replacement even within the allowed root', async () => {
    const { allowed, dir } = await setup();
    const result = await createPatchApplyHandler(allowed)({ changes: [
      { path: 'dir/a.ts', content: 'new' },
    ] }, new AbortController().signal, {
      resolveBase: allowed, writeRoots: [allowed],
      fileCheckpoint: { turnId: 'test', touchedPaths: () => [], snapshotFile: async () => {
        await rename(dir, `${dir}-saved`);
        await mkdir(dir);
        await writeFile(join(dir, 'a.ts'), 'old');
      } },
    });
    expect(JSON.parse(result.content as string).status).toBe('validation_failed');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('old');
  });
});
