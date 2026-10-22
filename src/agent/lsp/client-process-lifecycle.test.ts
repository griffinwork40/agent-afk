import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as groups from '../../utils/kill-process-group.js';
import { killServerTree, killServerTreeAndWait, reapGroupOnRootExit } from './client-process.js';

afterEach(() => vi.restoreAllMocks());
function child(exitCode: number | null, signalCode: NodeJS.Signals | null) {
  return { pid: 4242, exitCode, signalCode, kill: vi.fn() } as unknown as ChildProcess;
}

describe('server PID lifetime', () => {
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

describe('reapGroupOnRootExit (root crashed first, helpers survive)', () => {
  it('signals the POSIX process group even though the root exit is already recorded', () => {
    const tree = vi.spyOn(groups, 'killProcessGroup').mockImplementation(() => {});
    for (const proc of [child(1, null), child(null, 'SIGSEGV')]) {
      reapGroupOnRootExit(proc, 'linux');
      expect(proc.kill).not.toHaveBeenCalled();
    }
    expect(tree).toHaveBeenCalledTimes(2);
    expect(tree).toHaveBeenCalledWith(4242, 'SIGKILL', { platform: 'linux' });
  });

  it('is a no-op on win32 (no process groups; taskkill cannot walk from a dead root)', () => {
    const tree = vi.spyOn(groups, 'killProcessGroup').mockImplementation(() => {});
    reapGroupOnRootExit(child(1, null), 'win32');
    expect(tree).not.toHaveBeenCalled();
  });

  it('never signals a missing or non-positive pid', () => {
    const tree = vi.spyOn(groups, 'killProcessGroup').mockImplementation(() => {});
    for (const pid of [undefined, 0, -1]) {
      reapGroupOnRootExit({ pid, exitCode: 1, signalCode: null, kill: vi.fn() } as unknown as ChildProcess, 'darwin');
    }
    expect(tree).not.toHaveBeenCalled();
  });
});
