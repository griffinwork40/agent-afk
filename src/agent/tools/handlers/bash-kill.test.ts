import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASH_KILL_PIPE_GRACE_MS, killBashProcess } from './bash-kill.js';

function stubbornProcess(pid: number | undefined = 42): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), stderr: new PassThrough(),
  }) as ChildProcess;
}

afterEach(() => vi.useRealTimers());

describe('Windows bash kill cleanup (#2742)', () => {
  it('releases orphan-held pipes within a bounded grace even without exit or close', () => {
    vi.useFakeTimers();
    const proc = stubbornProcess();
    const kill = vi.fn();
    killBashProcess(proc, 'win32', kill);
    expect(kill).toHaveBeenCalledWith(42);
    vi.advanceTimersByTime(BASH_KILL_PIPE_GRACE_MS - 1);
    expect(proc.stdout!.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(proc.stdout!.destroyed).toBe(true);
    expect(proc.stderr!.destroyed).toBe(true);
    expect(proc.listenerCount('close')).toBe(0);
  });

  it('also releases inherited pipes when the shell exits but close never arrives', () => {
    vi.useFakeTimers();
    const proc = stubbornProcess();
    killBashProcess(proc, 'win32', vi.fn());
    proc.emit('exit', null, 'SIGKILL');
    vi.advanceTimersByTime(BASH_KILL_PIPE_GRACE_MS);
    expect(proc.stdout!.destroyed).toBe(true);
    expect(proc.stderr!.destroyed).toBe(true);
  });

  it('cancels cleanup on normal close, preserving drained output', () => {
    vi.useFakeTimers();
    const proc = stubbornProcess();
    killBashProcess(proc, 'win32', vi.fn());
    proc.emit('close', null, 'SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BASH_KILL_PIPE_GRACE_MS);
    expect(proc.stdout!.destroyed).toBe(false);
  });

  it('does not change POSIX stream lifecycle or add a timer', () => {
    vi.useFakeTimers();
    const proc = stubbornProcess();
    const kill = vi.fn();
    killBashProcess(proc, 'linux', kill);
    expect(kill).toHaveBeenCalledWith(42);
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
    expect(proc.stdout!.destroyed).toBe(false);
  });

  it('does not attempt a kill without a spawned pid', () => {
    const proc = stubbornProcess();
    Object.assign(proc, { pid: undefined });
    const kill = vi.fn();
    killBashProcess(proc, 'linux', kill);
    expect(kill).not.toHaveBeenCalled();
  });
});
