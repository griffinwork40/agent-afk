import { describe, it, expect, vi, afterEach } from 'vitest';
import { killProcessGroup } from './kill-process-group.js';
import * as cp from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

describe('killProcessGroup', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('sends negative-PID SIGKILL on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(12345);
    expect(spy).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('accepts a custom signal on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(42, 'SIGTERM');
    expect(spy).toHaveBeenCalledWith(-42, 'SIGTERM');
  });

  it('uses taskkill on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    killProcessGroup(99);
    expect(cp.execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '99'],
      expect.objectContaining({ stdio: 'ignore', timeout: 5_000 }),
    );
  });

  it('does nothing when pid is 0', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when pid is negative', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(-5);
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows ESRCH (already dead) on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    // Should not throw
    expect(() => killProcessGroup(123)).not.toThrow();
  });

  it('swallows taskkill failure on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error('taskkill: process not found');
    });
    expect(() => killProcessGroup(123)).not.toThrow();
  });
});
