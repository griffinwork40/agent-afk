import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../agent/awareness/presence.js', () => ({ readPresenceFiles: vi.fn(async () => []) }));
vi.mock('../../agent/daemon-instance.lock.js', () => ({ getDaemonLockPath: () => 'daemon-marker' }));
vi.mock('../../agent/process-liveness.js', () => ({ isProcessAlive: vi.fn(() => true) }));
vi.mock('../../telegram/manager.js', () => ({ getManagerPaths: () => ({ pidFile: 'bot-marker' }) }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => { throw new Error('ENOENT'); }) }));
vi.mock('../../service/index.js', () => ({
  SERVICE_NAMES: ['telegram', 'daemon'],
  serviceManagerFor: vi.fn(() => ({ status: vi.fn(() => ({ running: false })) })),
}));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../utils/npm-cli.js', () => ({ resolveNpmCli: () => 'npm-cli.js' }));
vi.mock('../version.js', () => ({ getVersion: () => '1.0.0' }));
vi.mock('../update-checker.js', () => ({
  fetchLatestVersion: vi.fn(async () => '2.0.0'),
  writePendingUpdateMarker: vi.fn(), writeUpdateCache: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { spawn } from 'child_process';
import { readPresenceFiles, type PresenceRecord } from '../../agent/awareness/presence.js';
import { isProcessAlive } from '../../agent/process-liveness.js';
import { serviceManagerFor, type ServiceManager } from '../../service/index.js';
import { writePendingUpdateMarker } from '../update-checker.js';
import { createEbusyDetector, findWindowsUpdateBlockers } from './update.windows.js';
import { registerUpdateCommand } from './update.js';

const originalPlatform = process.platform;
let savedExitCode: typeof process.exitCode;
const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};
const presence = (pid: number, liveness: string = 'alive') => ({ pid, liveness }) as PresenceRecord;
async function update(...args: string[]) {
  const program = new Command();
  registerUpdateCommand(program);
  await program.parseAsync(['node', 'afk', 'update', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPresenceFiles).mockResolvedValue([]);
  vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(serviceManagerFor).mockReturnValue({ status: vi.fn(() => ({ running: false })) } as unknown as ServiceManager);
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  setPlatform('win32');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  setPlatform(originalPlatform);
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe('Windows update preflight', () => {
  it('excludes the updater, dead and unknown records; deduplicates live PIDs', async () => {
    vi.mocked(readPresenceFiles).mockResolvedValue([
      presence(process.pid), presence(123), presence(123), presence(456, 'dead'), presence(789, 'dead'),
    ]);
    expect(await findWindowsUpdateBlockers()).toEqual(['afk session (PID 123) — close its terminal/session']);
  });

  it('names running services without changing them', async () => {
    const status = vi.fn(() => ({ running: true }));
    vi.mocked(serviceManagerFor).mockReturnValue({ status } as unknown as ServiceManager);
    expect(await findWindowsUpdateBlockers()).toEqual([
      'telegram service — stop AFK-telegram in Windows Task Scheduler',
      'daemon service — stop AFK-daemon in Windows Task Scheduler',
    ]);
    expect(status.mock.calls).toEqual([['telegram'], ['daemon']]);
  });

  it('ignores unavailable service status', async () => {
    vi.mocked(serviceManagerFor).mockReturnValue({ status: () => { throw new Error('unavailable'); } } as unknown as ServiceManager);
    expect(await findWindowsUpdateBlockers()).toEqual([]);
  });

  it('detects live bot and default daemon PID markers', async () => {
    vi.mocked(readFile).mockResolvedValue('123\n');
    const blockers = await findWindowsUpdateBlockers();
    expect(blockers).toHaveLength(2);
    expect(blockers.join('\n')).toContain('Telegram bot PID marker (123)');
    expect(blockers.join('\n')).toContain('daemon PID marker (123)');
  });

  it.each(['0', '-1', '123junk', '1e3', '2147483648', String(process.pid)])('ignores invalid or own marker %s', async (raw) => {
    vi.mocked(readFile).mockResolvedValue(raw);
    expect(await findWindowsUpdateBlockers()).toEqual([]);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it('ignores stale PID markers', async () => {
    vi.mocked(readFile).mockResolvedValue('123');
    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(await findWindowsUpdateBlockers()).toEqual([]);
  });

  it.each(['darwin', 'linux'] as const)('does not read registries or services on %s', async (platform) => {
    expect(await findWindowsUpdateBlockers(platform)).toEqual([]);
    expect(readPresenceFiles).not.toHaveBeenCalled();
    expect(serviceManagerFor).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses before npm (noRestart=%s)', async (noRestart) => {
    vi.mocked(readPresenceFiles).mockResolvedValue([presence(123)]);
    await update('--pin', '2.0.0', ...(noRestart ? ['--no-restart'] : []));
    expect(spawn).not.toHaveBeenCalled();
    expect(writePendingUpdateMarker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('PID 123');
  });

  it('leaves --check available without inspecting blockers', async () => {
    await update('--check');
    expect(readPresenceFiles).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

function npmResult(code: number | null, signal: NodeJS.Signals | null, output: string[], channel: 'stdout' | 'stderr' = 'stderr') {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      child.emit('exit', code, signal);
      for (const chunk of output) child[channel].write(Buffer.from(chunk));
      child.emit('close', code, signal);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

describe('npm Windows EBUSY fallback', () => {
  it.each(['stdout', 'stderr'] as const)('forwards %s and recognizes a split EBUSY after exit', async (channel) => {
    npmResult(16, null, ['npm error EB', 'US', 'Y: locked\n'], channel);
    await update('--pin', '2.0.0');
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), { stdio: ['inherit', 'pipe', 'pipe'] });
    expect(process[channel].write).toHaveBeenCalledWith(Buffer.from('npm error EB'));
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('Windows cannot replace a loaded native binary');
    expect(process.exitCode).toBe(16);
    expect(writePendingUpdateMarker).not.toHaveBeenCalled();
  });

  it.each([0, 1])('does not mislabel success or an unrelated error (exit %s)', async (code) => {
    npmResult(code, null, [code === 0 ? 'EBUSY recovered' : 'EACCES']);
    await update('--pin', '2.0.0');
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('npm reported EBUSY');
    expect(writePendingUpdateMarker).toHaveBeenCalledTimes(code === 0 ? 1 : 0);
    expect(process.exitCode).toBe(code === 0 ? undefined : 1);
  });

  it('handles a spawn EBUSY error', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('busy'), { code: 'EBUSY' })));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await update('--pin', '2.0.0');
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('npm reported EBUSY');
  });

  it('preserves signal failure', async () => {
    npmResult(null, 'SIGTERM', []);
    await update('--pin', '2.0.0');
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('SIGTERM');
  });

  it.each(['darwin', 'linux'] as const)('retains inherited stdio and generic npm failure on %s', async (platform) => {
    setPlatform(platform);
    npmResult(17, null, ['EBUSY']);
    await update('--pin', '2.0.0');
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), { stdio: 'inherit' });
    expect(readPresenceFiles).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('npm reported EBUSY');
    expect(process.exitCode).toBe(17);
  });

  it('keeps each stream detector independent and bounded across arbitrary chunks', () => {
    const detect = createEbusyDetector();
    expect(detect(Buffer.from('x'.repeat(10000) + 'EB'))).toBe(false);
    expect(detect(Buffer.from('US'))).toBe(false);
    expect(detect(Buffer.from('Y'))).toBe(true);
    expect(createEbusyDetector()(Buffer.from('USY'))).toBe(false);
  });
});
