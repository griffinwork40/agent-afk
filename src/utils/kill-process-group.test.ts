import { EventEmitter } from 'node:events';
import type { spawn, ChildProcess } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { killProcessGroup } from './kill-process-group.js';

afterEach(() => vi.restoreAllMocks());

describe('killProcessGroup', () => {
  it('sends negative-PID SIGKILL on POSIX', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(12345, 'SIGKILL', { platform: 'darwin' });
    expect(spy).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('accepts a custom signal on POSIX', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessGroup(42, 'SIGTERM', { platform: 'linux' });
    expect(spy).toHaveBeenCalledWith(-42, 'SIGTERM');
  });

  it('launches bounded taskkill asynchronously on win32 and ignores async errors', () => {
    const killer = new EventEmitter() as ChildProcess;
    killer.unref = vi.fn();
    const launch = vi.fn(() => killer);
    const kill = vi.spyOn(process, 'kill');
    killProcessGroup(99, 'SIGKILL', { platform: 'win32', spawn: launch as typeof spawn });
    expect(launch).toHaveBeenCalledWith(
      'taskkill', ['/F', '/T', '/PID', '99'],
      { stdio: 'ignore', timeout: 5_000, windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(() => killer.emit('error', new Error('taskkill unavailable'))).not.toThrow();
  });

  it.each([0, -5])('does nothing when pid is %s', (pid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const launch = vi.fn();
    killProcessGroup(pid, 'SIGKILL', { platform: 'win32', spawn: launch as typeof spawn });
    killProcessGroup(pid, 'SIGKILL', { platform: 'linux' });
    expect(kill).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('swallows ESRCH (already dead) on POSIX', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('kill ESRCH'); });
    expect(() => killProcessGroup(123, 'SIGKILL', { platform: 'darwin' })).not.toThrow();
  });

  it('swallows synchronous taskkill launch failure on win32', () => {
    const launch = vi.fn(() => { throw new Error('taskkill: process not found'); });
    expect(() => killProcessGroup(123, 'SIGKILL', {
      platform: 'win32', spawn: launch as typeof spawn,
    })).not.toThrow();
  });
});
