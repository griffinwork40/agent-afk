import { EventEmitter } from 'node:events';
import type { spawn, ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcessGroupAndWait } from './kill-process-group.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const killer = new EventEmitter() as ChildProcess;
  killer.unref = vi.fn();
  const launch = vi.fn(() => killer);
  return { killer, launch, deps: { platform: 'win32' as const, spawn: launch as typeof spawn } };
}

describe('killProcessGroupAndWait', () => {
  it('waits for taskkill close, not the spawn or root exit', async () => {
    const { killer, launch, deps } = setup();
    const done = vi.fn();
    const waiting = killProcessGroupAndWait(99, 'SIGKILL', deps).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '99'],
      { stdio: 'ignore', timeout: 5000, windowsHide: true });
    killer.emit('close', 0);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    expect(killer.listenerCount('close')).toBe(0);
  });

  it('bounds a taskkill that never completes and cleans up completion listeners', async () => {
    vi.useFakeTimers();
    const { killer, deps } = setup();
    const waiting = killProcessGroupAndWait(99, 'SIGKILL', deps, 100);
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(killer.listenerCount('close')).toBe(0);
    // A late launcher error must still have the shared diagnostic listener.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => killer.emit('error', new Error('late'))).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('settles on a taskkill error without throwing', async () => {
    const { killer, deps } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waiting = killProcessGroupAndWait(99, 'SIGKILL', deps);
    killer.emit('error', new Error('unavailable'));
    await expect(waiting).resolves.toBeUndefined();
  });

  it('signals POSIX groups synchronously and ignores invalid pids', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await killProcessGroupAndWait(42, 'SIGKILL', { platform: 'linux' });
    expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL');
    const { launch, deps } = setup();
    await killProcessGroupAndWait(0, 'SIGKILL', deps);
    expect(launch).not.toHaveBeenCalled();
  });
});
