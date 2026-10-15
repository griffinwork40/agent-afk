import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFileWrite, resolveWriteTarget } from './write-file.atomic.js';
import { writeFileHandler } from './write-file.js';
import { _resetWriteDenylistCacheForTests } from './write-denylist.js';

let dir: string;
const live = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'afk-write-atomic-'));
});

afterEach(() => {
  // Restore write permission in case a test made the dir read-only.
  try { chmodSync(dir, 0o755); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('commitFileWrite', () => {
  it('replaces an existing file and leaves no temp files behind', async () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'old');
    await commitFileWrite(f, 'new content', live());
    expect(readFileSync(f, 'utf8')).toBe('new content');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('creates parent directories for a new file', async () => {
    const f = path.join(dir, 'nested', 'deep', 'b.txt');
    await commitFileWrite(f, 'hi', live());
    expect(readFileSync(f, 'utf8')).toBe('hi');
  });

  it('preserves the existing permission bits exactly (not umask-masked)', async () => {
    const f = path.join(dir, 'script.sh');
    writeFileSync(f, '#!/bin/sh\necho old\n');
    chmodSync(f, 0o775);
    const before = statSync(f).mode & 0o7777;
    await commitFileWrite(f, '#!/bin/sh\necho new\n', live());
    expect(statSync(f).mode & 0o7777).toBe(before);
  });

  it('gives a new file the same mode a plain writeFile would', async () => {
    const reference = path.join(dir, 'reference.txt');
    writeFileSync(reference, 'x');
    const f = path.join(dir, 'fresh.txt');
    await commitFileWrite(f, 'x', live());
    expect(statSync(f).mode & 0o7777).toBe(statSync(reference).mode & 0o7777);
  });

  it('writes through a symlink, keeping the link a link', async () => {
    const target = path.join(dir, 'real.txt');
    const link = path.join(dir, 'link.txt');
    writeFileSync(target, 'old');
    symlinkSync(target, link);
    await commitFileWrite(link, 'via link', live());
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('via link');
  });

  it('creates the target of a dangling symlink, like writeFile does', async () => {
    const target = path.join(dir, 'missing-target.txt');
    const link = path.join(dir, 'dangling.txt');
    symlinkSync(target, link);
    expect(await resolveWriteTarget(link)).toBe(target);
    await commitFileWrite(link, 'created', live());
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('created');
  });

  it('an aborted write leaves the original intact and removes the temp file', async () => {
    const f = path.join(dir, 'keep.txt');
    writeFileSync(f, 'original');
    const ac = new AbortController();
    ac.abort('interrupted');
    await expect(commitFileWrite(f, 'should not land', ac.signal)).rejects.toBeDefined();
    expect(readFileSync(f, 'utf8')).toBe('original');
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('still refuses to overwrite a read-only file (rename must not bypass it)', async () => {
    const f = path.join(dir, 'readonly.txt');
    writeFileSync(f, 'protected');
    chmodSync(f, 0o444);
    try {
      await expect(commitFileWrite(f, 'clobbered', live())).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
      expect(readFileSync(f, 'utf8')).toBe('protected');
      expect(readdirSync(dir)).toEqual(['readonly.txt']);
    } finally {
      chmodSync(f, 0o644);
    }
  });

  it('falls back to an in-place write when the directory refuses a temp file', async () => {
    const f = path.join(dir, 'locked-dir.txt');
    writeFileSync(f, 'old');
    // Directory not writable (no temp file possible) but the file itself is.
    // Where the platform/user ignores the dir bit, the atomic path simply
    // succeeds instead; the observable contract (content written) is the same.
    chmodSync(dir, 0o555);
    await commitFileWrite(f, 'written anyway', live());
    expect(readFileSync(f, 'utf8')).toBe('written anyway');
  });
});

describe('write_file handler abort', () => {
  it('an abort landing after the pre-flight check reports not-modified and leaves the file intact', async () => {
    const f = path.join(dir, 'h.txt');
    writeFileSync(f, 'original');
    const ac = new AbortController();
    // The microtask fires during the handler's first await (the diff
    // pre-read), i.e. after its synchronous pre-flight abort check, so the
    // abort is observed inside the commit step.
    queueMicrotask(() => ac.abort('interrupted'));
    const result = await writeFileHandler({ file_path: f, content: 'new' }, ac.signal, {
      cwd: dir,
      resolveBase: dir,
    } as Parameters<typeof writeFileHandler>[2]);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Aborted; .*h\.txt was not modified$/);
    expect(readFileSync(f, 'utf8')).toBe('original');
    expect(readdirSync(dir)).toEqual(['h.txt']);
  });
});

describe('write_file handler: dangling-symlink containment', () => {
  let root: string;
  let outside: string;
  const confined = (): Parameters<typeof writeFileHandler>[2] =>
    ({ cwd: root, resolveBase: root, writeRoots: [root], readRoots: [root] }) as Parameters<
      typeof writeFileHandler
    >[2];

  beforeEach(() => {
    root = path.join(dir, 'root');
    outside = path.join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    _resetWriteDenylistCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetWriteDenylistCacheForTests();
  });

  it('refuses a contained dangling link to an outside target and does not create its parent dir', async () => {
    const outsideParent = path.join(outside, 'new-parent');
    const link = path.join(root, 'escape.txt');
    symlinkSync(path.join(outsideParent, 'pwned.txt'), link);
    const result = await writeFileHandler({ file_path: link, content: 'x' }, live(), confined());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed write roots/);
    expect(existsSync(outsideParent)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a contained dangling link into an existing outside dir and creates no file', async () => {
    const link = path.join(root, 'escape.txt');
    symlinkSync(path.join(outside, 'pwned.txt'), link);
    const result = await writeFileHandler({ file_path: link, content: 'x' }, live(), confined());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed write roots/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a dangling link whose target is denylisted', async () => {
    const protectedDir = path.join(root, 'protected');
    mkdirSync(protectedDir);
    vi.stubEnv('AFK_WRITE_DENYLIST', protectedDir);
    const link = path.join(root, 'sneaky.txt');
    symlinkSync(path.join(protectedDir, 'secret.json'), link);
    const result = await writeFileHandler({ file_path: link, content: 'x' }, live(), confined());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/refusing to write to protected path/);
    expect(readdirSync(protectedDir)).toEqual([]);
  });

  it('still writes through a dangling link whose target stays inside the root', async () => {
    const link = path.join(root, 'ok-link.txt');
    const target = path.join(root, 'sub', 'real.txt');
    symlinkSync(target, link);
    const result = await writeFileHandler({ file_path: link, content: 'fine' }, live(), confined());
    expect(result.isError).toBeFalsy();
    expect(readFileSync(target, 'utf8')).toBe('fine');
  });
});
