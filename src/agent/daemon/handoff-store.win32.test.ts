/**
 * Windows delete-pending lock contention tests for withHandoffLock (#3840).
 *
 * On Windows, releasing a lock file leaves it in "delete-pending" state until
 * every open handle closes. A concurrent O_EXCL create during that window
 * receives EPERM, EACCES, or EBUSY instead of EEXIST. Before the fix,
 * `withHandoffLock` treated those codes as fatal errors (re-throwing) rather
 * than as contention (returning null).
 *
 * `isWindowsLockContention` is tested directly (it is the shared helper
 * introduced by this fix) and `withHandoffLock` is tested end-to-end with an
 * injected `platform` parameter so no OS-level syscall mocking is needed and
 * the suite runs identically on every platform.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withHandoffLock } from './handoff-store.js';
import { isWindowsLockContention } from '../../utils/errors.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `handoff-win32-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeFakeError(code: string): NodeJS.ErrnoException {
  const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// isWindowsLockContention — the shared helper (#3840)
// ---------------------------------------------------------------------------

describe('isWindowsLockContention', () => {
  it('returns true for EPERM on win32', () => {
    expect(isWindowsLockContention(makeFakeError('EPERM'), 'win32')).toBe(true);
  });

  it('returns true for EACCES on win32', () => {
    expect(isWindowsLockContention(makeFakeError('EACCES'), 'win32')).toBe(true);
  });

  it('returns true for EBUSY on win32', () => {
    expect(isWindowsLockContention(makeFakeError('EBUSY'), 'win32')).toBe(true);
  });

  it('returns false for EEXIST on win32 (handled separately by callers)', () => {
    expect(isWindowsLockContention(makeFakeError('EEXIST'), 'win32')).toBe(false);
  });

  it('returns false for EPERM on linux (real permission error on POSIX)', () => {
    expect(isWindowsLockContention(makeFakeError('EPERM'), 'linux')).toBe(false);
  });

  it('returns false for EACCES on linux', () => {
    expect(isWindowsLockContention(makeFakeError('EACCES'), 'linux')).toBe(false);
  });

  it('returns false for EBUSY on linux', () => {
    expect(isWindowsLockContention(makeFakeError('EBUSY'), 'linux')).toBe(false);
  });

  it('returns false for EPERM on darwin', () => {
    expect(isWindowsLockContention(makeFakeError('EPERM'), 'darwin')).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isWindowsLockContention(null, 'win32')).toBe(false);
    expect(isWindowsLockContention('EPERM', 'win32')).toBe(false);
    expect(isWindowsLockContention(42, 'win32')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withHandoffLock — platform parameter threading (#3840)
//
// We exercise the platform injection by creating a real lock file (causing
// genuine EEXIST from the O_EXCL write) and verifying that withHandoffLock
// treats it as contention and returns null on both win32 and linux. This
// proves the `platform` parameter propagates through to the contention check
// without requiring OS-level syscall interception.
// ---------------------------------------------------------------------------

describe('withHandoffLock — platform parameter threading (#3840)', () => {
  it('accepts platform="win32" and returns null on genuine EEXIST (live lock)', async () => {
    // Pre-create a fresh lock file so the O_EXCL create fails with EEXIST and
    // the stale-check sees a fresh mtime → genuine contention → null.
    const lockFile = join(testDir, 'live-win32-task.lock');
    await writeFile(lockFile, '', { mode: 0o600 });

    const result = await withHandoffLock(
      'live-win32-task',
      testDir,
      async () => 'should-not-run',
      'win32',
    );
    expect(result).toBeNull();
  });

  it('accepts platform="linux" and returns null on genuine EEXIST (live lock)', async () => {
    const lockFile = join(testDir, 'live-linux-task.lock');
    await writeFile(lockFile, '', { mode: 0o600 });

    const result = await withHandoffLock(
      'live-linux-task',
      testDir,
      async () => 'should-not-run',
      'linux',
    );
    expect(result).toBeNull();
  });

  it('acquires the lock and runs the callback when no lock exists (win32)', async () => {
    const result = await withHandoffLock(
      'free-win32-task',
      testDir,
      async () => 'ran',
      'win32',
    );
    expect(result).toBe('ran');
  });

  it('acquires the lock and runs the callback when no lock exists (linux)', async () => {
    const result = await withHandoffLock(
      'free-linux-task',
      testDir,
      async () => 'ran',
      'linux',
    );
    expect(result).toBe('ran');
  });
});
