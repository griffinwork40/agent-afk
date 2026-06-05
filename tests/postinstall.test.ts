import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type KillStaleDaemonFn = (pidFilePath: string, killFn?: (pid: number, signal: string) => void) => void;

let killStaleDaemon: KillStaleDaemonFn;

beforeAll(async () => {
  // Dynamic import avoids TypeScript transform issues with plain .mjs files.
  // Pattern mirrors src/cli/postinstall.test.ts exactly.
  const mod = await import('../scripts/postinstall.mjs');
  killStaleDaemon = mod.killStaleDaemon as KillStaleDaemonFn;
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
