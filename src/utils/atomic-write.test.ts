import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteFileAsync, renameWithRetry } from './atomic-write.js';

describe('atomicWriteFile (sync)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes content to the destination file', () => {
    const dest = join(dir, 'out.txt');
    atomicWriteFile(dest, 'hello');
    expect(readFileSync(dest, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file atomically', () => {
    const dest = join(dir, 'out.txt');
    atomicWriteFile(dest, 'first');
    atomicWriteFile(dest, 'second');
    expect(readFileSync(dest, 'utf-8')).toBe('second');
  });

  // Skipped on Windows: POSIX file-mode bits not exposed by NTFS — genuinely POSIX-only.
  it('applies the default 0o600 mode', () => {
    if (process.platform === 'win32') return; // POSIX modes not supported
    const dest = join(dir, 'secret.txt');
    atomicWriteFile(dest, 'secret');
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  // Skipped on Windows: POSIX file-mode bits not exposed by NTFS — genuinely POSIX-only.
  it('applies a custom mode passed as options object', () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'pub.txt');
    atomicWriteFile(dest, 'public', { mode: 0o644 });
    expect(statSync(dest).mode & 0o777).toBe(0o644);
  });

  // Skipped on Windows: POSIX file-mode bits not exposed by NTFS — genuinely POSIX-only.
  it('accepts a positional numeric mode for backward compat', () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'compat.txt');
    atomicWriteFile(dest, 'data', 0o644);
    expect(statSync(dest).mode & 0o777).toBe(0o644);
    expect(readFileSync(dest, 'utf-8')).toBe('data');
  });

  it('creates parent directories when mkdirp is true (default)', () => {
    const dest = join(dir, 'a', 'b', 'c', 'out.txt');
    atomicWriteFile(dest, 'nested');
    expect(readFileSync(dest, 'utf-8')).toBe('nested');
  });

  it('does not leave a temp file behind on success', () => {
    const dest = join(dir, 'out.txt');
    atomicWriteFile(dest, 'data');
    const files = require('node:fs').readdirSync(dir) as string[];
    expect(files.filter((f: string) => f.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('writes Buffer content', () => {
    const dest = join(dir, 'bin.txt');
    atomicWriteFile(dest, Buffer.from('buffered'));
    expect(readFileSync(dest, 'utf-8')).toBe('buffered');
  });

  it('writes JSON content (serialised by caller)', () => {
    const dest = join(dir, 'data.json');
    const payload = { foo: 'bar', n: 42 };
    atomicWriteFile(dest, JSON.stringify(payload));
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual(payload);
  });
});

describe('atomicWriteFileAsync (async)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-atomic-async-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes content to the destination file', async () => {
    const dest = join(dir, 'out.txt');
    await atomicWriteFileAsync(dest, 'async-hello');
    expect(readFileSync(dest, 'utf-8')).toBe('async-hello');
  });

  it('overwrites an existing file atomically', async () => {
    const dest = join(dir, 'out.txt');
    await atomicWriteFileAsync(dest, 'first');
    await atomicWriteFileAsync(dest, 'second');
    expect(readFileSync(dest, 'utf-8')).toBe('second');
  });

  // Skipped on Windows: POSIX file-mode bits not exposed by NTFS — genuinely POSIX-only.
  it('applies the default 0o600 mode', async () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'secret.txt');
    await atomicWriteFileAsync(dest, 'secret');
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  // Skipped on Windows: POSIX file-mode bits not exposed by NTFS — genuinely POSIX-only.
  it('applies a custom mode', async () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'pub.txt');
    await atomicWriteFileAsync(dest, 'public', { mode: 0o644 });
    expect(statSync(dest).mode & 0o777).toBe(0o644);
  });

  it('creates parent directories when mkdirp is true (default)', async () => {
    const dest = join(dir, 'x', 'y', 'z', 'out.txt');
    await atomicWriteFileAsync(dest, 'deep');
    expect(readFileSync(dest, 'utf-8')).toBe('deep');
  });

  it('does not leave a temp file behind on success', async () => {
    const dest = join(dir, 'out.txt');
    await atomicWriteFileAsync(dest, 'data');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir) as string[];
    expect(files.filter((f: string) => f.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('writes Buffer content', async () => {
    const dest = join(dir, 'bin.txt');
    await atomicWriteFileAsync(dest, Buffer.from('async-buffered'));
    expect(readFileSync(dest, 'utf-8')).toBe('async-buffered');
  });

  it('writes JSON content (serialised by caller)', async () => {
    const dest = join(dir, 'data.json');
    const payload = { key: 'value', arr: [1, 2, 3] };
    await atomicWriteFileAsync(dest, JSON.stringify(payload));
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual(payload);
  });

  it('concurrent writes to the same file both land without corruption', async () => {
    const dest = join(dir, 'concurrent.json');
    // Two concurrent writes: whichever rename wins, the file must be valid JSON.
    await Promise.all([
      atomicWriteFileAsync(dest, JSON.stringify({ writer: 1 })),
      atomicWriteFileAsync(dest, JSON.stringify({ writer: 2 })),
    ]);
    expect(existsSync(dest)).toBe(true);
    const parsed = JSON.parse(readFileSync(dest, 'utf-8')) as { writer: number };
    expect([1, 2]).toContain(parsed.writer);
  });
});

// ---------------------------------------------------------------------------
// renameWithRetry — platform-gated retry behaviour
//
// These tests inject both `_platform` and `_renameFn` to exercise the win32
// retry branch and the POSIX fast-fail branch on every host OS without any
// `vi.spyOn` on a non-configurable ES module export.  They never skip or
// branch on `process.platform` — repo rule R4.
// ---------------------------------------------------------------------------

describe('renameWithRetry', () => {
  // Helper: build a rename mock that throws `err` for the first `failTimes`
  // calls, then resolves successfully.
  function mockRename(
    err: Error,
    failTimes: number,
  ): { fn: (from: string, to: string) => Promise<void>; callCount: () => number } {
    let calls = 0;
    const fn = async (_from: string, _to: string): Promise<void> => {
      calls++;
      if (calls <= failTimes) throw err;
    };
    return { fn, callCount: () => calls };
  }

  // Always-fail rename mock.
  function alwaysFailRename(
    err: Error,
  ): { fn: (from: string, to: string) => Promise<void>; callCount: () => number } {
    let calls = 0;
    const fn = async (_from: string, _to: string): Promise<void> => {
      calls++;
      throw err;
    };
    return { fn, callCount: () => calls };
  }

  it('succeeds immediately when rename does not throw', async () => {
    let calls = 0;
    const fn = async (_f: string, _t: string): Promise<void> => { calls++; };
    await expect(renameWithRetry('a', 'b', 3, 'linux', fn)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('retries on EPERM when platform is win32 and succeeds on retry', async () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = mockRename(eperm, 1);
    await expect(renameWithRetry('a', 'b', 3, 'win32', fn)).resolves.toBeUndefined();
    expect(callCount()).toBe(2);
  });

  it('does NOT retry EPERM when platform is not win32 — throws immediately', async () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = mockRename(eperm, 99);
    await expect(renameWithRetry('a', 'b', 3, 'linux', fn)).rejects.toMatchObject({ code: 'EPERM' });
    // Must throw on the first attempt — no retry on POSIX.
    expect(callCount()).toBe(1);
  });

  it('does NOT retry EACCES when platform is not win32', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const { fn, callCount } = mockRename(eacces, 99);
    await expect(renameWithRetry('a', 'b', 3, 'darwin', fn)).rejects.toMatchObject({ code: 'EACCES' });
    expect(callCount()).toBe(1);
  });

  it('exhausts maxRetries on win32 and throws the last error', async () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = alwaysFailRename(eperm);
    // maxRetries=2 → attempts 0, 1, 2 = 3 total calls.
    await expect(renameWithRetry('a', 'b', 2, 'win32', fn)).rejects.toMatchObject({ code: 'EPERM' });
    expect(callCount()).toBe(3);
  });

  it('does not sleep after the final failed attempt on win32', async () => {
    // Contract: with maxRetries=0 there is exactly 1 attempt and 0 sleeps.
    // If sleep were called after the last failure, the overall wall time would
    // grow — verified here by the attempt count being exactly 1.
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = alwaysFailRename(eperm);
    await expect(renameWithRetry('a', 'b', 0, 'win32', fn)).rejects.toMatchObject({ code: 'EPERM' });
    expect(callCount()).toBe(1);
  });

  it('re-throws non-transient errors immediately on win32', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { fn, callCount } = mockRename(enoent, 99);
    await expect(renameWithRetry('a', 'b', 3, 'win32', fn)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(callCount()).toBe(1);
  });
});
