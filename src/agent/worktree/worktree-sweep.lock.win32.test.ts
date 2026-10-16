/**
 * Windows delete-pending lock contention tests for acquireLock (#3840).
 *
 * On Windows, releasing a lock file leaves it in "delete-pending" state until
 * every open handle closes. A concurrent O_EXCL create during that window
 * receives EPERM, EACCES, or EBUSY instead of EEXIST. Before the fix,
 * `acquireLock` treated those as fatal errors rather than contention, causing
 * hard failures on Windows where POSIX callers would have seen LockContestedError.
 *
 * Platform is injected so this suite runs on any OS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, LockContestedError } from './worktree-sweep.lock.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sweep-lock-win32-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeFakeError(code: string): NodeJS.ErrnoException {
  const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Acquire a lock at `lockPath` but make the first O_EXCL open throw `err`,
 * simulating a Windows delete-pending hit. The lock file is pre-created so
 * the stale-PID branch sees a live PID (process.pid) and stays contested.
 */
async function acquireWithFakeFirstError(
  lockPath: string,
  err: NodeJS.ErrnoException,
): Promise<void> {
  // Pre-create the lock file with the current PID so the stale check finds a
  // live process and correctly throws LockContestedError.
  await fs.writeFile(lockPath, String(process.pid), 'utf-8');

  // Monkey-patch fs.open: first call throws the injected error, subsequent
  // calls delegate to the real implementation.
  const realOpen = fs.open.bind(fs);
  let firstCall = true;
  const patched = async (...args: Parameters<typeof fs.open>) => {
    if (firstCall) {
      firstCall = false;
      throw err;
    }
    return realOpen(...args);
  };
  fs.open = patched;
  try {
    await acquireLock(lockPath, 'win32');
  } finally {
    fs.open = realOpen;
  }
}

describe('acquireLock — Windows delete-pending contention (#3840)', () => {
  it('treats EPERM on win32 as LockContestedError, not a hard throw', async () => {
    const lockPath = join(testDir, 'eperm.lock');
    await expect(
      acquireWithFakeFirstError(lockPath, makeFakeError('EPERM')),
    ).rejects.toBeInstanceOf(LockContestedError);
  });

  it('treats EACCES on win32 as LockContestedError, not a hard throw', async () => {
    const lockPath = join(testDir, 'eacces.lock');
    await expect(
      acquireWithFakeFirstError(lockPath, makeFakeError('EACCES')),
    ).rejects.toBeInstanceOf(LockContestedError);
  });

  it('treats EBUSY on win32 as LockContestedError, not a hard throw', async () => {
    const lockPath = join(testDir, 'ebusy.lock');
    await expect(
      acquireWithFakeFirstError(lockPath, makeFakeError('EBUSY')),
    ).rejects.toBeInstanceOf(LockContestedError);
  });

  it('still throws non-contention errors on win32 (e.g. EACCES on a real permission problem)', async () => {
    // On POSIX, EPERM/EACCES/EBUSY must still propagate as hard errors.
    const lockPath = join(testDir, 'posix-eperm.lock');
    await fs.writeFile(lockPath, String(process.pid), 'utf-8');

    const realOpen = fs.open.bind(fs);
    let firstCall = true;
    const patched = async (...args: Parameters<typeof fs.open>) => {
      if (firstCall) {
        firstCall = false;
        throw makeFakeError('EPERM');
      }
      return realOpen(...args);
    };
    fs.open = patched;
    try {
      await expect(
        acquireLock(lockPath, 'linux'),
      ).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      fs.open = realOpen;
    }
  });

  it('acquires successfully on an uncontested lock with win32 platform', async () => {
    const lockPath = join(testDir, 'clean.lock');
    const release = await acquireLock(lockPath, 'win32');
    expect(typeof release).toBe('function');
    await release();
  });
});
