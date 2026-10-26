/**
 * Tests for daemon-instance.lock — single-instance guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, DaemonAlreadyRunningError, getDaemonLockPath } from './daemon-instance.lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-daemon-lock-test-'));
  lockPath = join(tmpDir, 'daemon.lock');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireDaemonLock', () => {
  it('acquires the lock and writes the current PID', async () => {
    const release = await acquireDaemonLock(lockPath);
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(lockPath, 'utf-8');
    expect(parseInt(content.trim(), 10)).toBe(process.pid);
    await release();
  });

  it('release removes the lock file', async () => {
    const release = await acquireDaemonLock(lockPath);
    await release();
    const { existsSync } = await import('node:fs');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release is idempotent — second call is a no-op', async () => {
    const release = await acquireDaemonLock(lockPath);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('throws DaemonAlreadyRunningError when this process holds the lock', async () => {
    const release = await acquireDaemonLock(lockPath);
    try {
      await expect(acquireDaemonLock(lockPath)).rejects.toThrow(DaemonAlreadyRunningError);
    } finally {
      await release();
    }
  });

  it('DaemonAlreadyRunningError carries the owner PID', async () => {
    const release = await acquireDaemonLock(lockPath);
    try {
      let caught: DaemonAlreadyRunningError | undefined;
      try {
        await acquireDaemonLock(lockPath);
      } catch (err) {
        caught = err as DaemonAlreadyRunningError;
      }
      expect(caught).toBeDefined();
      expect(caught!.ownerPid).toBe(process.pid);
      expect(caught!.message).toContain(String(process.pid));
      expect(caught!.message).toContain('already running');
    } finally {
      await release();
    }
  });

  it('clears a stale lock (dead PID) and acquires successfully', async () => {
    const { writeFileSync } = await import('node:fs');
    // Write a lock file with a PID that cannot be alive (PID 1 is init/launchd
    // and will never be "our" process; we use a clearly-dead synthetic PID).
    // Use a PID that process.kill(pid, 0) will throw ESRCH for.
    // We write PID 999999999 which is beyond the Linux/macOS PID_MAX.
    writeFileSync(lockPath, '999999999', 'utf-8');

    const release = await acquireDaemonLock(lockPath);
    const { readFileSync } = await import('node:fs');
    expect(parseInt(readFileSync(lockPath, 'utf-8').trim(), 10)).toBe(process.pid);
    await release();
  });

  it('creates parent directories if they do not exist', async () => {
    const deepLock = join(tmpDir, 'nested', 'sub', 'daemon.lock');
    const release = await acquireDaemonLock(deepLock);
    const { existsSync } = await import('node:fs');
    expect(existsSync(deepLock)).toBe(true);
    await release();
  });
});

describe('getDaemonLockPath', () => {
  it('returns a string ending in daemon.lock', () => {
    const p = getDaemonLockPath();
    expect(p).toMatch(/daemon\.lock$/);
  });

  it('includes the instanceId in the path', () => {
    const p = getDaemonLockPath('myinstance');
    expect(p).toContain('myinstance');
  });
});
