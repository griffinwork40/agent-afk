/**
 * Windows delete-pending lock contention tests for acquireRegistryLock (#3840).
 *
 * On Windows, releasing a lock file leaves it in "delete-pending" state until
 * every open handle closes. A concurrent O_EXCL create during that window
 * receives EPERM, EACCES, or EBUSY. Before the fix, `acquireRegistryLock`
 * treated those as fatal non-EEXIST errors and returned null ("could not lock")
 * rather than retrying as contention.
 *
 * Platform is injected so this suite runs on any OS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRegistryLock } from './worktree-root-registry.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'wt-reg-win32-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeFakeError(code: string): NodeJS.ErrnoException {
  const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('acquireRegistryLock — Windows delete-pending contention (#3840)', () => {
  it('retries and acquires after a EPERM on win32 (contention, not fatal)', async () => {
    const lockPath = join(testDir, 'test.lock');

    // Patch fs.open: first call throws EPERM (simulating delete-pending),
    // second call succeeds normally.
    const realOpen = fs.open.bind(fs);
    let callCount = 0;
    const patched = async (...args: Parameters<typeof fs.open>) => {
      callCount++;
      if (callCount === 1) throw makeFakeError('EPERM');
      return realOpen(...args);
    };
    // @ts-expect-error — intentional partial override for testing
    fs.open = patched;
    try {
      const release = await acquireRegistryLock(lockPath, 'win32');
      // Should have retried and acquired (not returned null).
      expect(release).not.toBeNull();
      if (release !== null) await release();
    } finally {
      fs.open = realOpen;
    }
  });

  it('retries and acquires after EACCES on win32', async () => {
    const lockPath = join(testDir, 'eacces.lock');

    const realOpen = fs.open.bind(fs);
    let callCount = 0;
    const patched = async (...args: Parameters<typeof fs.open>) => {
      callCount++;
      if (callCount === 1) throw makeFakeError('EACCES');
      return realOpen(...args);
    };
    // @ts-expect-error — intentional partial override for testing
    fs.open = patched;
    try {
      const release = await acquireRegistryLock(lockPath, 'win32');
      expect(release).not.toBeNull();
      if (release !== null) await release();
    } finally {
      fs.open = realOpen;
    }
  });

  it('retries and acquires after EBUSY on win32', async () => {
    const lockPath = join(testDir, 'ebusy.lock');

    const realOpen = fs.open.bind(fs);
    let callCount = 0;
    const patched = async (...args: Parameters<typeof fs.open>) => {
      callCount++;
      if (callCount === 1) throw makeFakeError('EBUSY');
      return realOpen(...args);
    };
    // @ts-expect-error — intentional partial override for testing
    fs.open = patched;
    try {
      const release = await acquireRegistryLock(lockPath, 'win32');
      expect(release).not.toBeNull();
      if (release !== null) await release();
    } finally {
      fs.open = realOpen;
    }
  });

  it('returns null immediately for EPERM on POSIX (real permission error)', async () => {
    const lockPath = join(testDir, 'posix-eperm.lock');

    const realOpen = fs.open.bind(fs);
    const patched = async (..._args: Parameters<typeof fs.open>) => {
      throw makeFakeError('EPERM');
    };
    // @ts-expect-error — intentional partial override for testing
    fs.open = patched;
    try {
      const release = await acquireRegistryLock(lockPath, 'linux');
      // On POSIX, EPERM is a real error → treated as "could not lock" → null.
      expect(release).toBeNull();
    } finally {
      fs.open = realOpen;
    }
  });

  it('acquires successfully on an uncontested lock with win32 platform', async () => {
    const lockPath = join(testDir, 'clean.lock');
    const release = await acquireRegistryLock(lockPath, 'win32');
    expect(release).not.toBeNull();
    if (release !== null) await release();
  });
});
