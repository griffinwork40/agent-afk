/** Portable integration coverage: simulate Windows orphan-held pipes, no platform skips. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBashHandler } from './bash.js';
import { BASH_KILL_PIPE_GRACE_MS } from './bash-kill.js';
import { DetachableToolRegistry, type DetachedToolResult } from '../detach-registry.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
vi.mock('./bash-kill.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bash-kill.js')>();
  return { ...actual, killBashProcess: (proc: ChildProcess) => actual.killBashProcess(proc, 'win32', () => {}) };
});

let proc: ChildProcess;
beforeEach(() => {
  vi.useFakeTimers();
  proc = Object.assign(new EventEmitter(), {
    pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
  }) as ChildProcess;
  vi.mocked(spawn).mockReturnValue(proc);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('bash with Windows orphan-held stdio (#2742)', () => {
  it('timeout settles immediately and releases pipes despite no close', async () => {
    const result = createBashHandler('default')({ command: 'sleep 30', timeout_ms: 100 }, new AbortController().signal);
    proc.stdout!.emit('data', Buffer.from('partial output'));
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).content).toContain('timed out');
    expect((await result).content).toContain('partial output');
    await vi.advanceTimersByTimeAsync(BASH_KILL_PIPE_GRACE_MS);
    expect(proc.stdout!.destroyed).toBe(true);
    expect(proc.stderr!.destroyed).toBe(true);
  });

  it('abort settles immediately and releases pipes despite no exit', async () => {
    const abort = new AbortController();
    const result = createBashHandler('default')({ command: 'sleep 30' }, abort.signal);
    abort.abort();
    expect((await result).isError).toBe(true);
    await vi.advanceTimersByTimeAsync(BASH_KILL_PIPE_GRACE_MS);
    expect(proc.stdout!.destroyed).toBe(true);
    expect(proc.stderr!.destroyed).toBe(true);
  });

  it('post-detach abort delivers once even when neither exit nor close arrives', async () => {
    const abort = new AbortController();
    const registry = new DetachableToolRegistry();
    const delivered: DetachedToolResult[] = [];
    registry.on('settled', (r: DetachedToolResult) => delivered.push(r));
    const result = createBashHandler('default')({ command: 'sleep 30' }, abort.signal, {
      detachRegistry: registry, toolUseId: 'orphan',
    });
    registry.detachAll();
    expect((await result).content).toContain('detached');
    abort.abort();
    await vi.advanceTimersByTimeAsync(BASH_KILL_PIPE_GRACE_MS);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.status).toBe('failed');
    expect(proc.stdout!.destroyed).toBe(true);
    proc.emit('close', null, 'SIGKILL');
    expect(delivered).toHaveLength(1);
    expect(registry.listRunning()).toEqual([]);
  });
});
