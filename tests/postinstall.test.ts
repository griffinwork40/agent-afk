import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type KillStaleDaemonFn = (pidFilePath: string, killFn?: (pid: number, signal: string) => void) => void;
type IsManualBotRunningFn = (
  pidFilePath: string,
  probeFn?: (pid: number, signal: number) => void,
) => number | null;
type RestartLaunchdServicesFn = (opts?: {
  home?: string;
  uid?: number;
  labels?: string[];
  existsFn?: (p: string) => boolean;
  execFn?: (argv: string[]) => void;
}) => string[];

let killStaleDaemon: KillStaleDaemonFn;
let isManualBotRunning: IsManualBotRunningFn;
let restartLaunchdServices: RestartLaunchdServicesFn;

beforeAll(async () => {
  // Dynamic import avoids TypeScript transform issues with plain .mjs files.
  // Pattern mirrors src/cli/postinstall.test.ts exactly.
  const mod = await import('../scripts/postinstall.mjs');
  killStaleDaemon = mod.killStaleDaemon as KillStaleDaemonFn;
  isManualBotRunning = mod.isManualBotRunning as IsManualBotRunningFn;
  restartLaunchdServices = mod.restartLaunchdServices as RestartLaunchdServicesFn;
});

describe('killStaleDaemon', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-kill-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('silently returns when PID file does not exist', () => {
    const missing = join(tmpDir, 'no-such.pid');
    expect(() => killStaleDaemon(missing)).not.toThrow();
  });

  it('silently returns when PID file contains non-numeric content', () => {
    const pidFile = join(tmpDir, 'garbage.pid');
    writeFileSync(pidFile, 'not-a-pid');
    const killFn = vi.fn();
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
    expect(killFn).not.toHaveBeenCalled();
  });

  it('silently returns when process.kill throws ESRCH (process not found)', () => {
    const pidFile = join(tmpDir, 'stale.pid');
    writeFileSync(pidFile, '999999999');
    const killFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
  });

  it('calls killFn(pid, "SIGTERM") when PID file contains a valid numeric PID', () => {
    const pidFile = join(tmpDir, 'live.pid');
    writeFileSync(pidFile, '12345');
    const killFn = vi.fn();
    killStaleDaemon(pidFile, killFn);
    expect(killFn).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('silently returns when killFn throws EPERM (cross-user permission denied)', () => {
    const pidFile = join(tmpDir, 'other-user.pid');
    writeFileSync(pidFile, '42');
    const killFn = vi.fn(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
    expect(killFn).toHaveBeenCalledWith(42, 'SIGTERM');
  });
});

describe('isManualBotRunning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-botprobe-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null when the PID file does not exist', () => {
    const missing = join(tmpDir, 'no-such.pid');
    const probeFn = vi.fn();
    expect(isManualBotRunning(missing, probeFn)).toBeNull();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('returns null (and never probes) for non-numeric PID content', () => {
    const pidFile = join(tmpDir, 'garbage.pid');
    writeFileSync(pidFile, 'not-a-pid');
    const probeFn = vi.fn();
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('returns the PID and probes with signal 0 when the process is alive', () => {
    const pidFile = join(tmpDir, 'live.pid');
    writeFileSync(pidFile, '4321');
    const probeFn = vi.fn(); // no throw = process exists
    expect(isManualBotRunning(pidFile, probeFn)).toBe(4321);
    expect(probeFn).toHaveBeenCalledWith(4321, 0);
  });

  it('returns null when the probe throws ESRCH (stale PID, process gone)', () => {
    const pidFile = join(tmpDir, 'stale.pid');
    writeFileSync(pidFile, '999999999');
    const probeFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
  });

  it('returns null when the probe throws EPERM (process owned by another user)', () => {
    const pidFile = join(tmpDir, 'other.pid');
    writeFileSync(pidFile, '42');
    const probeFn = vi.fn(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
  });

  it('does NOT delete a stale PID file (read-only, unlike manager.isRunning)', () => {
    const pidFile = join(tmpDir, 'stale-keep.pid');
    writeFileSync(pidFile, '999999999');
    const probeFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    isManualBotRunning(pidFile, probeFn);
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe('restartLaunchdServices', () => {
  const HOME = '/Users/tester';
  const TELEGRAM_PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.afk.telegram.plist');
  const DAEMON_PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.afk.daemon.plist');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] and never shells out when no service plist exists', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      existsFn: () => false,
      execFn,
    });
    expect(result).toEqual([]);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('restarts only services whose plist exists, with the correct kickstart argv', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      existsFn: (p) => p === TELEGRAM_PLIST, // only telegram installed
      execFn,
    });
    expect(result).toEqual(['com.afk.telegram']);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledWith(['kickstart', '-k', 'gui/1000/com.afk.telegram']);
  });

  it('restarts both services when both plists exist', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 501,
      existsFn: (p) => p === TELEGRAM_PLIST || p === DAEMON_PLIST,
      execFn,
    });
    expect(result).toEqual(['com.afk.telegram', 'com.afk.daemon']);
    expect(execFn).toHaveBeenNthCalledWith(1, ['kickstart', '-k', 'gui/501/com.afk.telegram']);
    expect(execFn).toHaveBeenNthCalledWith(2, ['kickstart', '-k', 'gui/501/com.afk.daemon']);
  });

  it('swallows a launchctl error for one service and still attempts the other', () => {
    const execFn = vi.fn((argv: string[]) => {
      if (argv[2]?.endsWith('com.afk.telegram')) {
        throw new Error('Could not find service'); // not loaded
      }
    });
    const result = restartLaunchdServices({
      home: HOME,
      uid: 501,
      existsFn: () => true, // both plists present
      execFn,
    });
    // telegram threw → excluded; daemon succeeded → included. No throw.
    expect(result).toEqual(['com.afk.daemon']);
    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it('honours a custom labels list', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      labels: ['com.afk.daemon'],
      existsFn: (p) => p === DAEMON_PLIST,
      execFn,
    });
    expect(result).toEqual(['com.afk.daemon']);
    expect(execFn).toHaveBeenCalledWith(['kickstart', '-k', 'gui/1000/com.afk.daemon']);
  });
});
