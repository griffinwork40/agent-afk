/**
 * Coverage tests for src/telegram/manager.ts (COV-014).
 *
 * Exercises: isRunning, status, stop, start (spawn path), parseEtime.
 * No real child processes are spawned — child_process.spawn is mocked.
 * No real timers — sleep is mocked to resolve immediately.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock sleep so start()'s 1.5s settle window is instant.
vi.mock('../agent/providers/shared/sleep-with-abort.js', () => ({
  sleep: vi.fn(async () => {}),
}));

// Mock paths so state never touches real ~/.afk
const tmpBase = mkdtempSync(join(tmpdir(), 'afk-manager-test-'));
vi.mock('../paths.js', () => ({
  getAfkStateDir: vi.fn(() => tmpBase),
  getLogsDir: vi.fn(() => join(tmpBase, 'logs')),
}));

// child_process mock — controlled per-test
const mockSpawn = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: mockSpawn };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateDir(): { pidFile: string; logFile: string } {
  const stateDir = join(tmpBase, 'telegram');
  const logsDir = join(tmpBase, 'logs');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return {
    pidFile: join(stateDir, 'bot.pid'),
    logFile: join(logsDir, 'telegram.log'),
  };
}

function writePid(pidFile: string, pid: number | string): void {
  writeFileSync(pidFile, String(pid), { mode: 0o644 });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clean up any pid/log files between tests.
  try { rmSync(join(tmpBase, 'telegram', 'bot.pid'), { force: true }); } catch { /* ignore */ }
  try { rmSync(join(tmpBase, 'logs', 'telegram.log'), { force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseEtime
// ---------------------------------------------------------------------------

describe('parseEtime', () => {
  test('parses mm:ss', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('02:30')).toBe(150);
  });

  test('parses hh:mm:ss', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('01:02:03')).toBe(3723);
  });

  test('parses dd-hh:mm:ss', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('1-00:00:00')).toBe(86400);
  });

  test('parses ss only', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('45')).toBe(45);
  });

  test('returns undefined for empty string', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('')).toBeUndefined();
  });

  test('returns undefined for non-numeric segments', async () => {
    const { parseEtime } = await import('./manager.js');
    expect(parseEtime('xx:yy')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEntrypoint (already tested in manager.test.ts; just confirm export)
// ---------------------------------------------------------------------------

describe('resolveEntrypoint', () => {
  test('is exported', async () => {
    const { resolveEntrypoint } = await import('./manager.js');
    expect(typeof resolveEntrypoint).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// getManagerPaths
// ---------------------------------------------------------------------------

describe('getManagerPaths', () => {
  test('returns pidFile and logFile strings', async () => {
    const { getManagerPaths } = await import('./manager.js');
    const paths = getManagerPaths();
    expect(paths.pidFile).toMatch(/bot\.pid$/);
    expect(paths.logFile).toMatch(/telegram\.log$/);
  });
});

// ---------------------------------------------------------------------------
// isRunning
// ---------------------------------------------------------------------------

describe('isRunning', () => {
  test('returns null when pid file does not exist', async () => {
    const { isRunning } = await import('./manager.js');
    expect(isRunning('/nonexistent/path/bot.pid')).toBeNull();
  });

  test('removes stale pid file and returns null for non-numeric content', async () => {
    const { pidFile } = makeStateDir();
    writePid(pidFile, 'notanumber');
    const { isRunning } = await import('./manager.js');
    const result = isRunning(pidFile);
    expect(result).toBeNull();
  });

  test('removes stale pid file and returns null for a dead PID', async () => {
    const { pidFile } = makeStateDir();
    // PID 99999999 is almost certainly not running.
    writePid(pidFile, 99999999);
    const { isRunning } = await import('./manager.js');
    const result = isRunning(pidFile);
    expect(result).toBeNull();
  });

  test('returns the PID when the process is alive (own PID)', async () => {
    const { pidFile } = makeStateDir();
    writePid(pidFile, process.pid);
    const { isRunning } = await import('./manager.js');
    expect(isRunning(pidFile)).toBe(process.pid);
    // Clean up pid file (don't leave our own PID around)
    rmSync(pidFile, { force: true });
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status', () => {
  test('returns running=false when no pid file', async () => {
    const { status } = await import('./manager.js');
    const s = status();
    expect(s.running).toBe(false);
    expect(s.pid).toBeUndefined();
  });

  test('returns running=false with logTail when log file exists', async () => {
    const { pidFile: _pid, logFile } = makeStateDir();
    writeFileSync(logFile, 'line1\nline2\nline3\n');
    const { status } = await import('./manager.js');
    const s = status();
    expect(s.running).toBe(false);
    expect(Array.isArray(s.logTail)).toBe(true);
    expect(s.logTail).toContain('line1');
  });

  test('returns running=true with pid when process is alive', async () => {
    const { pidFile } = makeStateDir();
    writePid(pidFile, process.pid);
    const { status } = await import('./manager.js');
    const s = status();
    expect(s.running).toBe(true);
    expect(s.pid).toBe(process.pid);
    rmSync(pidFile, { force: true });
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('stop', () => {
  test('returns not-running when no pid file', async () => {
    const { stop } = await import('./manager.js');
    const result = await stop();
    expect(result.kind).toBe('not-running');
  });

  test('returns stopped when SIGTERM kills the process quickly', async () => {
    const { pidFile } = makeStateDir();
    // Use our own PID — we'll mock process.kill to avoid actually signalling.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (sig === 'SIGTERM') {
        // Immediately remove the pid file to simulate fast exit.
        rmSync(pidFile, { force: true });
      }
      return true;
    });
    writePid(pidFile, process.pid);

    const { stop } = await import('./manager.js');
    const result = await stop();
    expect(result.kind).toBe('stopped');
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// start — spawn path
// ---------------------------------------------------------------------------

describe('start', () => {
  test('returns already-running when pid file has a live PID', async () => {
    const { pidFile } = makeStateDir();
    writePid(pidFile, process.pid);

    const { start } = await import('./manager.js');
    const result = await start();
    expect(result.kind).toBe('already-running');
    rmSync(pidFile, { force: true });
  });

  test('returns spawn-failed when spawn throws', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('spawn error'); });

    // Stub resolveEntrypoint so we don't need real filesystem layouts.
    vi.doMock('./manager.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('./manager.js')>();
      return {
        ...real,
        resolveEntrypoint: vi.fn(() => '/fake/telegram.ts'),
      };
    });

    const { start } = await import('./manager.js');
    const result = await start();
    expect(result.kind).toBe('spawn-failed');
  });

  test('returns spawn-failed when child has no pid', async () => {
    const childMock = {
      pid: undefined,
      unref: vi.fn(),
      on: vi.fn(),
    };
    mockSpawn.mockReturnValue(childMock);

    const { start } = await import('./manager.js');
    const result = await start();
    expect(result.kind).toBe('spawn-failed');
  });

  test('returns started when child stays alive after settle', async () => {
    const { pidFile } = makeStateDir();
    const fakePid = process.pid; // guaranteed alive
    const childMock = { pid: fakePid, unref: vi.fn(), on: vi.fn() };
    mockSpawn.mockReturnValue(childMock);

    // After spawn, start() writes fakePid to the pid file and then checks
    // isRunning. Since fakePid === process.pid it will be alive.
    const { start } = await import('./manager.js');
    const result = await start();
    expect(result.kind).toBe('started');
    expect((result as { kind: string; pid?: number }).pid).toBe(fakePid);
    rmSync(pidFile, { force: true });
  });

  test('returns exited-immediately when child dies in settle window', async () => {
    const deadPid = 99999998; // not running
    const childMock = { pid: deadPid, unref: vi.fn(), on: vi.fn() };
    mockSpawn.mockReturnValue(childMock);

    const { start } = await import('./manager.js');
    const result = await start();
    // The pid file was written with deadPid but isRunning removes it (ESRCH).
    expect(result.kind).toBe('exited-immediately');
  });
});
