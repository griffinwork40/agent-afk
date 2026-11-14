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

  it('lock with dead PID still keeps controller paused (existence = paused)', async () => {
    const { PauseController, getPauseLockPath } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });

    // Write a lock with a very unlikely (dead) PID and a 60s-old timestamp.
    // Under the old design this would be auto-cleaned; now it must stay.
    const lockPath = getPauseLockPath();
    const deadPidData = {
      pid: 999999999,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(deadPidData), 'utf8');

    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 600));
      // Lock file existence is the sole pause signal — dead PID is irrelevant.
      expect(ctrl.isPaused()).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      ctrl.dispose();
    }
  });

  it('removePauseLock() is the only way to resume (lock is not auto-cleaned)', async () => {
    const { PauseController, writePauseLock, removePauseLock, getPauseLockPath } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    writePauseLock();
    expect(fs.existsSync(getPauseLockPath())).toBe(true);

    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 600));
      expect(ctrl.isPaused()).toBe(true);

      // Waiting longer should NOT auto-clean the lock.
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(true);
      expect(fs.existsSync(getPauseLockPath())).toBe(true);

      // Only removePauseLock() clears it.
      removePauseLock();
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(false);
      expect(fs.existsSync(getPauseLockPath())).toBe(false);
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

  // -------------------------------------------------------------------------
  // consumeLastPauseDuration() — one-shot behaviour
  // -------------------------------------------------------------------------

  it('consumeLastPauseDuration() is one-shot: second call returns undefined', async () => {
    const { PauseController, writePauseLock, removePauseLock } = await getPauseMod();

    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    writePauseLock();

    const ctrl = PauseController.instance();
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(true);

      removePauseLock();
      await new Promise((r) => setTimeout(r, 400));
      expect(ctrl.isPaused()).toBe(false);

      const first = ctrl.consumeLastPauseDuration();
      expect(typeof first).toBe('number');
      expect(first).toBeGreaterThan(0);

      // Second call must return undefined — the slot was cleared.
      const second = ctrl.consumeLastPauseDuration();
      expect(second).toBeUndefined();
    } finally {
      ctrl.dispose();
    }
  });

  it('consumeLastPauseDuration() returns undefined when no pause has occurred', async () => {
    const { PauseController } = await getPauseMod();
    const ctrl = PauseController.instance();
    try {
      expect(ctrl.consumeLastPauseDuration()).toBeUndefined();
    } finally {
      ctrl.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// formatPauseNote — shared note formatter
// ---------------------------------------------------------------------------

describe('formatPauseNote', () => {
  it('returns undefined for durations at or below 60 s', async () => {
    const { formatPauseNote } = await getPauseMod();
    expect(formatPauseNote(0)).toBeUndefined();
    expect(formatPauseNote(60_000)).toBeUndefined();
    expect(formatPauseNote(59_999)).toBeUndefined();
  });

  it('formats minutes-only for durations under one hour', async () => {
    const { formatPauseNote } = await getPauseMod();
    const note = formatPauseNote(5 * 60_000 + 500); // 5m 0.5s → rounds to 5m
    expect(note).toMatch(/5m/);
    expect(note).not.toMatch(/\dh/);
    expect(note).toContain('Session resumed');
  });

  it('formats hours and minutes for durations over one hour', async () => {
    const { formatPauseNote } = await getPauseMod();
    const note = formatPauseNote(21 * 3_600_000 + 15 * 60_000); // 21h 15m
    expect(note).toMatch(/21h 15m/);
    expect(note).toContain('Session resumed');
  });

  it('note text mentions provider throttling', async () => {
    const { formatPauseNote } = await getPauseMod();
    const note = formatPauseNote(2 * 60_000);
    expect(note).toContain('provider throttling');
  });
});
