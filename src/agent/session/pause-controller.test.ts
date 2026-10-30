/**
 * Tests for PauseController.
 *
 * Uses a temp directory via AFK_HOME env override (same pattern as
 * presence.test.ts) to isolate lock files from the real state dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pause-ctrl-test-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpDir;
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = origAfkHome;
  }
});

// Dynamic import after env setup so paths.ts picks up the temp AFK_HOME.
async function getPauseMod() {
  vi.resetModules();
  return import('./pause-controller.js');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PauseController', () => {
  it('check() returns immediately when not paused', async () => {
    const { PauseController } = await getPauseMod();
    const ctrl = PauseController.instance();
    try {
      await expect(ctrl.check()).resolves.toBeUndefined();
    } finally {
      ctrl.dispose();
    }
  });

  it('isPaused() returns false when no lock file exists', async () => {
    const { PauseController } = await getPauseMod();
    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(ctrl.isPaused()).toBe(false);
    } finally {
      ctrl.dispose();
    }
  });

  it('check() blocks when paused and resolves when lock is removed', async () => {
    const { PauseController, writePauseLock, removePauseLock, getPauseLockPath } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    writePauseLock();
    expect(fs.existsSync(getPauseLockPath())).toBe(true);

    const ctrl = PauseController.instance();
    try {
      // Allow poll to detect the lock.
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(true);

      let resolved = false;
      const checkPromise = ctrl.check().then(() => { resolved = true; });

      await new Promise((r) => setTimeout(r, 50));
      expect(resolved).toBe(false);

      // Remove lock → check() should resolve within poll interval.
      removePauseLock();
      await new Promise((r) => setTimeout(r, 400));
      await checkPromise;
      expect(resolved).toBe(true);
    } finally {
      ctrl.dispose();
    }
  });

  it('check() rejects when abort signal fires while paused', async () => {
    const { PauseController, writePauseLock, getPauseLockPath } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    writePauseLock();
    expect(fs.existsSync(getPauseLockPath())).toBe(true);

    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(true);

      const ac = new AbortController();
      const checkPromise = ctrl.check(ac.signal);

      setTimeout(() => ac.abort(new Error('interrupted')), 50);

      await expect(checkPromise).rejects.toThrow('interrupted');
    } finally {
      ctrl.dispose();
    }
  });

  it('auto-cleans a stale lock (dead PID, old timestamp)', async () => {
    const { PauseController, getPauseLockPath } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });

    // Write a lock with a very unlikely PID and a 60s-old timestamp.
    const lockPath = getPauseLockPath();
    const staleData = {
      pid: 999999999,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleData), 'utf8');

    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 600));
      expect(ctrl.isPaused()).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      ctrl.dispose();
    }
  });

  it('dispose() unblocks pending check() callers', async () => {
    const { PauseController, writePauseLock } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    writePauseLock();

    const ctrl = PauseController.instance();
    await new Promise((r) => setTimeout(r, 400));
    expect(ctrl.isPaused()).toBe(true);

    let settled = false;
    const checkPromise = ctrl.check()
      .then(() => { settled = true; })
      .catch(() => { settled = true; });

    ctrl.dispose();
    await checkPromise;
    expect(settled).toBe(true);
  });
});
