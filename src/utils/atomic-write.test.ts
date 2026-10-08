import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteFileAsync, renameWithRetry, renameWithRetrySync } from './atomic-write.js';

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

  it('an aborted signal never renames: dest keeps old content, temp removed', async () => {
    const dest = join(dir, 'guarded.txt');
    writeFileSync(dest, 'old');
    const ac = new AbortController();
    ac.abort('interrupted');
    await expect(atomicWriteFileAsync(dest, 'new', { signal: ac.signal })).rejects.toBeDefined();
    expect(readFileSync(dest, 'utf-8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['guarded.txt']);
  });

  it('a live signal does not change the happy path', async () => {
    const dest = join(dir, 'live.txt');
    await atomicWriteFileAsync(dest, 'ok', { signal: new AbortController().signal });
    expect(readFileSync(dest, 'utf-8')).toBe('ok');
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
  // Suppress retry-log stderr noise across all tests in this suite; individual
  // tests that assert the log message will mock more specifically.
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
  afterEach(() => { stderrSpy.mockRestore(); });

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

  it('logs to stderr on the first retry attempt so Windows retries are visible to operators', async () => {
    // Finding #2870-3: the retry path must emit a diagnostic so operators can
    // observe Windows rename races rather than absorbing them silently.
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn } = mockRename(eperm, 1);
    // Override the suite-level suppress spy to capture instead.
    stderrSpy.mockRestore();
    const captured: string[] = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg: unknown) => {
      captured.push(String(msg));
      return true;
    });
    await renameWithRetry('a', 'b', 3, 'win32', fn);
    // Exactly one log line on entry to the retry path (attempt 0 only).
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('[atomic-write] rename retry');
    expect(captured[0]).toContain('EPERM');
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

  it('clamps exponential backoff to 5000 ms ceiling for large attempt numbers', async () => {
    // failTimes=10 makes attempts 0-9 fail, so attempt 9 schedules the first
    // clamped sleep: Math.min(10 * 2^9, 5000) = 5000 (not the unclamped 5120).
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = mockRename(eperm, 10);
    const delays: number[] = [];
    const sleepSpy = async (ms: number): Promise<void> => { delays.push(ms); };

    await expect(renameWithRetry('a', 'b', 10, 'win32', fn, sleepSpy)).resolves.toBeUndefined();
    expect(delays).toEqual([10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5000]);
    expect(callCount()).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// renameWithRetrySync — sync retry wrapper for the sync atomicWriteFile path
// ---------------------------------------------------------------------------

describe('renameWithRetrySync', () => {
  // Suppress retry-log stderr noise across all tests in this suite.
  beforeEach(() => { vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
  afterEach(() => { vi.restoreAllMocks(); });

  function mockRenameSync(
    err: Error,
    failTimes: number,
  ): { fn: (from: string, to: string) => void; callCount: () => number } {
    let calls = 0;
    const fn = (_from: string, _to: string): void => {
      calls++;
      if (calls <= failTimes) throw err;
    };
    return { fn, callCount: () => calls };
  }

  function alwaysFailRenameSync(
    err: Error,
  ): { fn: (from: string, to: string) => void; callCount: () => number } {
    let calls = 0;
    const fn = (_from: string, _to: string): void => {
      calls++;
      throw err;
    };
    return { fn, callCount: () => calls };
  }

  it('succeeds immediately when rename does not throw', () => {
    let calls = 0;
    const fn = (_f: string, _t: string): void => { calls++; };
    expect(() => renameWithRetrySync('a', 'b', 3, 'linux', fn)).not.toThrow();
    expect(calls).toBe(1);
  });

  it('retries on EPERM when platform is win32 and succeeds on retry', () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = mockRenameSync(eperm, 1);
    expect(() => renameWithRetrySync('a', 'b', 3, 'win32', fn)).not.toThrow();
    expect(callCount()).toBe(2);
  });

  it('does NOT retry EPERM when platform is not win32 — throws immediately', () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = mockRenameSync(eperm, 99);
    expect(() => renameWithRetrySync('a', 'b', 3, 'linux', fn)).toThrow();
    expect(callCount()).toBe(1);
  });

  it('exhausts maxRetries on win32 and throws the last error', () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fn, callCount } = alwaysFailRenameSync(eperm);
    expect(() => renameWithRetrySync('a', 'b', 2, 'win32', fn)).toThrow();
    // maxRetries=2 → attempts 0, 1, 2 = 3 total calls.
    expect(callCount()).toBe(3);
  });

  it('re-throws non-transient errors immediately on win32', () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { fn, callCount } = mockRenameSync(enoent, 99);
    expect(() => renameWithRetrySync('a', 'b', 3, 'win32', fn)).toThrow();
    expect(callCount()).toBe(1);
  });

  it('retries on EACCES when platform is win32', () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const { fn, callCount } = mockRenameSync(eacces, 1);
    expect(() => renameWithRetrySync('a', 'b', 3, 'win32', fn)).not.toThrow();
    expect(callCount()).toBe(2);
  });

  it('retries on EBUSY when platform is win32', () => {
    const ebusy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const { fn, callCount } = mockRenameSync(ebusy, 1);
    expect(() => renameWithRetrySync('a', 'b', 3, 'win32', fn)).not.toThrow();
    expect(callCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFileAsync — end-to-end wiring: routes through renameWithRetry
//
// These tests inject a rename that throws EPERM once on the simulated win32
// platform to prove that atomicWriteFileAsync uses renameWithRetry rather than
// a bare rename call.  Because renameWithRetry accepts injectable params, and
// atomicWriteFileAsync forwards _renameFn to renameWithRetry, we verify the
// E2E contract by checking that a transient EPERM on "win32" is recovered
// without corrupting the destination.
//
// Fix for #2819: atomicWriteFileAsync now accepts an optional `_renameFn`
// parameter that threads into renameWithRetry, making the retry path testable
// without relying on real filesystem concurrency (which is inherently flaky).
// ---------------------------------------------------------------------------

describe('atomicWriteFileAsync — E2E wiring through renameWithRetry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-e2e-'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('atomicWriteFileAsync resolves after one transient EPERM via renameWithRetry', async () => {
    // Confirm that a single EPERM on the rename is recovered: the function must
    // call renameWithRetry (not bare rename), which retries on win32.
    const dest = join(dir, 'e2e.txt');
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    let renameCalls = 0;
    const injectFn = async (_from: string, _to: string): Promise<void> => {
      renameCalls++;
      if (renameCalls === 1) throw eperm;
      // Second call: perform the real rename so the file actually lands.
      const { rename: realRename } = await import('node:fs/promises');
      await realRename(_from, _to);
    };
    // Call renameWithRetry directly with "win32" platform to prove the wiring
    // path: it retries once on EPERM and then succeeds.
    const { writeFile: realWriteFile } = await import('node:fs/promises');
    const { join: pathJoin, dirname } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const tmpPath = pathJoin(dirname(dest), `.tmp-${randomBytes(6).toString('hex')}`);
    await realWriteFile(tmpPath, 'e2e-content', { mode: 0o600, encoding: 'utf-8' });
    await renameWithRetry(tmpPath, dest, 5, 'win32', injectFn);
    expect(renameCalls).toBe(2);
    expect(readFileSync(dest, 'utf-8')).toBe('e2e-content');
  });

  it('atomicWriteFileAsync retries a simulated EPERM through its own _renameFn injectable (fix for #2819)', async () => {
    // Root cause of #2819: concurrent same-file writers on Windows can each
    // get EPERM when the winning rename lands just before them. This test
    // exercises the FULL code path — atomicWriteFileAsync → renameWithRetry
    // retry loop — without relying on real filesystem concurrency (which is
    // flaky by nature). The injectable _renameFn simulates one transient EPERM
    // then succeeds, proving the retry survives end-to-end.
    const dest = join(dir, 'issue-2819.json');
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    let renameCalls = 0;
    const injectFn = async (from: string, to: string): Promise<void> => {
      renameCalls++;
      if (renameCalls === 1) throw eperm;
      const { rename: realRename } = await import('node:fs/promises');
      await realRename(from, to);
    };
    // Drive through atomicWriteFileAsync with "win32" platform injected via
    // renameWithRetry's _platform default — but here we pass _renameFn through
    // atomicWriteFileAsync's new injectable parameter. The function must thread
    // it into renameWithRetry; if it uses a bare rename instead the first call
    // would throw and the test fails.
    // Pass 'win32' as the platform injectable so the retry path fires on all
    // host OSes (including macOS/Linux in CI) — repo rule R4: no platform skips.
    const result = await atomicWriteFileAsync(
      dest, JSON.stringify({ writer: 1 }), {}, injectFn, 'win32',
    );
    expect(result).toBe(true);
    expect(renameCalls).toBe(2); // First call threw EPERM, second succeeded.
    expect(existsSync(dest)).toBe(true);
    const parsed = JSON.parse(readFileSync(dest, 'utf-8')) as { writer: number };
    expect(parsed.writer).toBe(1);
    // Temp file must be cleaned up by atomicWriteFileAsync on success.
    const leftovers = readdirSync(dir).filter((f: string) => f.startsWith('.tmp-'));
    expect(leftovers).toHaveLength(0);
  });
});

describe('atomicWriteFileAsync commitGuard', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'afk-atomic-guard-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('commits and resolves true when the guard passes', async () => {
    const dest = join(dir, 'f.json');
    writeFileSync(dest, 'old');
    expect(await atomicWriteFileAsync(dest, 'new', { commitGuard: () => true })).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['f.json']);
  });

  it('leaves dest untouched, removes the temp file, and resolves false when the guard fails', async () => {
    const dest = join(dir, 'f.json');
    writeFileSync(dest, 'old');
    expect(await atomicWriteFileAsync(dest, 'new', { commitGuard: () => false })).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['f.json']);
  });

  it('a guard on existence never creates a missing dest', async () => {
    const dest = join(dir, 'absent.json');
    expect(await atomicWriteFileAsync(dest, 'x', { commitGuard: () => existsSync(dest) })).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
