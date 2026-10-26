import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as groups from '../../utils/kill-process-group.js';
import { killServerTree, killServerTreeAndWait, killServerTreeSync } from './client-process.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
function child(exitCode: number | null, signalCode: NodeJS.Signals | null) {
  return { pid: 4242, exitCode, signalCode, kill: vi.fn() } as unknown as ChildProcess;
}

describe('server PID lifetime', () => {
  it('exit cleanup completes the win32 tree walk synchronously before killing the root', () => {
    const proc = child(null, null);
    const sync = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
      expect(proc.kill).not.toHaveBeenCalled();
      return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null };
    });
    killServerTreeSync(proc, 'win32');
    expect(sync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4242'],
      { stdio: 'ignore', timeout: 5000, windowsHide: true });
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('synchronous exit cleanup ignores recorded termination on both platforms', () => {
    const sync = vi.spyOn(childProcess, 'spawnSync');
    const tree = vi.spyOn(groups, 'killProcessGroup');
    for (const platform of ['linux', 'win32'] as const) {
      const proc = child(0, null);
      killServerTreeSync(proc, platform);
      expect(proc.kill).not.toHaveBeenCalled();
    }
    expect(sync).not.toHaveBeenCalled();
    expect(tree).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('never targets a reused PID after recorded exit on %s', async (platform) => {
    const tree = vi.spyOn(groups, 'killProcessGroup').mockImplementation(() => {});
    const awaited = vi.spyOn(groups, 'killProcessGroupAndWait').mockResolvedValue();
    for (const proc of [child(0, null), child(null, 'SIGKILL')]) {
      killServerTree(proc, platform);
      await killServerTreeAndWait(proc, 100, platform);
      expect(proc.kill).not.toHaveBeenCalled();
    }
    expect(tree).not.toHaveBeenCalled();
    expect(awaited).not.toHaveBeenCalled();
  });

  it('keeps the live win32 root alive until the awaited tree kill completes', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const kill = vi.spyOn(groups, 'killProcessGroupAndWait').mockReturnValue(pending);
    const proc = child(null, null);
    const done = vi.fn();
    const waiting = killServerTreeAndWait(proc, 100, 'win32').then(done);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL', { platform: 'win32' }, 100);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    finish();
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
