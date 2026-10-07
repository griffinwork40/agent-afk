/**
 * Cross-platform unit tests for `src/service/systemd/install.ts`.
 *
 * The sibling `service/systemd.test.ts` covers the full I/O surface via a
 * per-test tmpdir but skips on non-Linux (systemd is Linux-specific). These
 * tests mock `child_process`, `fs`, and `os` to run hermetically on any OS,
 * covering the logic paths that don't depend on a real kernel — specifically
 * `detectSystemdVersion`, `installSystemdService`, `uninstallSystemdService`,
 * and `readUnitFile` under platform-neutral conditions.
 *
 * Per POSIX guard R4: no test is gated on `process.platform`. All external
 * I/O (spawnSync, execFileSync, fs primitives) is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock hoisting (must be before any SUT import).
// ---------------------------------------------------------------------------

const {
  mockExecFileSync,
  mockSpawnSync,
  mockExistsSyncStore,
  mockMkdirSync,
  mockMkdirSyncCalls,
  mockRmSyncCalls,
  mockReadFileSync,
  mockAtomicWriteFile,
  atomicWritten,
  mockHomedir,
  telegramEntrypoint,
} = vi.hoisted(() => {
  // Track which paths "exist" in the virtual filesystem.
  const existsStore = new Set<string>();

  // Track atomicWriteFile calls so we can inspect what was written.
  const written: Map<string, string> = new Map();

  const mkdirCalls: string[] = [];
  const rmCalls: string[] = [];

  const telegramEntrypoint = { value: '/fake/dist/telegram.mjs' };
  const homedirValue = { value: '/home/testuser' };

  return {
    mockExecFileSync: vi.fn().mockReturnValue(Buffer.from('')),
    mockSpawnSync: vi.fn().mockReturnValue({
      status: 0,
      stdout: 'systemd 252\n',
      stderr: '',
      error: undefined,
    }),
    mockExistsSyncStore: existsStore,
    mockMkdirSync: vi.fn((_p: string) => { mkdirCalls.push(_p); }),
    mockMkdirSyncCalls: mkdirCalls,
    mockRmSyncCalls: rmCalls,
    mockReadFileSync: vi.fn().mockReturnValue(''),
    mockAtomicWriteFile: vi.fn((_path: string, content: string) => { written.set(_path, content); }),
    atomicWritten: written,
    mockHomedir: vi.fn(() => homedirValue.value),
    telegramEntrypoint,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExecFileSync, spawnSync: mockSpawnSync };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: string) => mockExistsSyncStore.has(p),
    mkdirSync: mockMkdirSync,
    rmSync: vi.fn((_p: string) => { mockExistsSyncStore.delete(_p); mockRmSyncCalls.push(_p); }),
    readFileSync: mockReadFileSync,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

vi.mock('../../utils/atomic-write.js', () => ({
  atomicWriteFile: mockAtomicWriteFile,
}));

vi.mock('../../utils/errors.js', () => ({
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock('../launchd/plist.js', () => ({
  resolveProgramArguments: vi.fn(
    (_name: string, _existsCheck?: (p: string) => boolean) => ['/usr/bin/node', telegramEntrypoint.value],
  ),
  resolveServicePath: vi.fn(() => '/usr/bin:/bin'),
  resolveWatchPaths: vi.fn(() => undefined),
}));

vi.mock('../telegram/manager.js', () => ({
  resolveEntrypoint: () => telegramEntrypoint.value,
}));

// SUT imported after mocks are in place.
import {
  detectSystemdVersion,
  installSystemdService,
  readUnitFile,
  uninstallSystemdService,
} from './install.js';
import { unitPath, pathUnitPath, restartUnitPath } from './paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = '/home/testuser';

/** Seed a "virtual file" so existsSync(p) returns true. */
function seedFile(p: string): void {
  mockExistsSyncStore.add(p);
}

/** Remove a "virtual file". */
function unseedFile(p: string): void {
  mockExistsSyncStore.delete(p);
}

beforeEach(() => {
  mockExistsSyncStore.clear();
  atomicWritten.clear();
  mockMkdirSyncCalls.length = 0;
  mockRmSyncCalls.length = 0;
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue(Buffer.from(''));
  mockSpawnSync.mockReset();
  mockSpawnSync.mockReturnValue({
    status: 0,
    stdout: 'systemd 252\n',
    stderr: '',
    error: undefined,
  });
  mockAtomicWriteFile.mockReset();
  mockAtomicWriteFile.mockImplementation((_path: string, content: string) => {
    atomicWritten.set(_path, content as string);
    // Seed the "file" so subsequent existsSync(p) returns true.
    mockExistsSyncStore.add(_path);
  });
  mockReadFileSync.mockReset();
  mockHomedir.mockReturnValue(HOME);
  telegramEntrypoint.value = '/fake/dist/telegram.mjs';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// detectSystemdVersion
// ---------------------------------------------------------------------------

describe('detectSystemdVersion', () => {
  it('parses the version integer from "systemd NNN" output', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'systemd 252\n', error: undefined });
    expect(detectSystemdVersion()).toBe(252);
  });

  it('parses a version with a build suffix ("systemd 237 (237-0ubuntu)")', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'systemd 237 (237-0ubuntu)\n', error: undefined });
    expect(detectSystemdVersion()).toBe(237);
  });

  it('returns undefined when spawnSync reports an error', () => {
    mockSpawnSync.mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') });
    expect(detectSystemdVersion()).toBeUndefined();
  });

  it('returns undefined when status is non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', error: undefined });
    expect(detectSystemdVersion()).toBeUndefined();
  });

  it('returns undefined when output cannot be parsed', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'some unrecognised output\n', error: undefined });
    expect(detectSystemdVersion()).toBeUndefined();
  });

  it('returns undefined when stdout is empty', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', error: undefined });
    expect(detectSystemdVersion()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// installSystemdService — already-installed guard
// ---------------------------------------------------------------------------

describe('installSystemdService — already-installed', () => {
  it('returns already-installed without calling systemctl when unit file exists', () => {
    const p = unitPath('telegram');
    seedFile(p);
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('already-installed');
    if (result.kind !== 'already-installed') return;
    expect(result.configPath).toBe(p);
    expect(result.label).toBe('afk-telegram.service');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// installSystemdService — error paths
// ---------------------------------------------------------------------------

describe('installSystemdService — resolveProgramArguments failure', () => {
  it('returns failed when resolveProgramArguments throws', async () => {
    // Dynamically override the mock for this test only.
    const plist = await import('../launchd/plist.js');
    const spy = vi.spyOn(plist, 'resolveProgramArguments').mockImplementationOnce(() => {
      throw new Error('Cannot find entrypoint');
    });
    const result = installSystemdService('telegram');
    spy.mockRestore();
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/Cannot find entrypoint/);
    }
  });
});

describe('installSystemdService — atomicWrite failure', () => {
  it('returns failed when the .service unit file write fails', () => {
    mockAtomicWriteFile.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/Failed to write unit/);
    }
  });
});

// ---------------------------------------------------------------------------
// installSystemdService — dry-run
// ---------------------------------------------------------------------------

describe('installSystemdService — dry-run', () => {
  it('writes the unit, skips systemctl, returns installed with manual-load notes', () => {
    const result = installSystemdService('telegram', {
      dryRun: true,
      _entrypointExistsCheck: () => true,
    });
    expect(result.kind).toBe('installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    // atomicWriteFile must have been called for the .service file.
    expect(atomicWritten.size).toBeGreaterThan(0);
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('systemctl --user daemon-reload'))).toBe(true);
      expect(result.notes?.some((n) => n.includes('enable-linger'))).toBe(true);
    }
  });

  it('includes a version-warning note when systemd version is below 240', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'systemd 239\n', error: undefined });
    const result = installSystemdService('telegram', {
      dryRun: true,
      _entrypointExistsCheck: () => true,
    });
    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('239') && n.includes('≥ 240'))).toBe(true);
    }
  });

  it('includes an unknown-version note when systemctl cannot be probed', () => {
    mockSpawnSync.mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') });
    const result = installSystemdService('telegram', {
      dryRun: true,
      _entrypointExistsCheck: () => true,
    });
    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('Could not detect'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// installSystemdService — happy path (live)
// ---------------------------------------------------------------------------

describe('installSystemdService — live install', () => {
  it('writes the .service unit, calls daemon-reload + enable --now, returns installed', () => {
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    if (result.kind !== 'installed') return;

    expect(result.label).toBe('afk-telegram.service');
    expect(result.autoRestartOnRebuild).toBe(false);

    // Unit file must have been written.
    const p = unitPath('telegram');
    expect(atomicWritten.has(p)).toBe(true);

    // systemctl calls: daemon-reload then enable --now.
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user daemon-reload'))).toBe(true);
    expect(calls.some((a) => a.includes('--user enable --now afk-telegram.service'))).toBe(true);

    // Linger advice must be included.
    expect(result.notes?.some((n) => n.includes('enable-linger'))).toBe(true);
  });

  it('includes a version-warning note when installed on an old systemd', () => {
    // First call (from detectSystemdVersion after enable) returns old version.
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'systemd 239\n', error: undefined });
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('239') && n.includes('≥ 240'))).toBe(true);
    }
  });

  it('rolls back the unit file and returns failed when systemctl enable throws', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('enable --now afk-telegram.service')) {
        throw new Error('Failed to connect to bus');
      }
      return Buffer.from('');
    });
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/systemctl enable failed/);
    }
    // rollbackWrittenUnits should have removed the written unit.
    expect(mockRmSyncCalls.length).toBeGreaterThan(0);
  });

  it('returns installed with noWatch=true without writing a .path unit', () => {
    const result = installSystemdService('telegram', {
      noWatch: true,
      _entrypointExistsCheck: () => true,
    });
    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') {
      expect(result.autoRestartOnRebuild).toBe(false);
    }
    // No .path unit should have been written.
    const pp = pathUnitPath('telegram');
    expect(atomicWritten.has(pp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installSystemdService — path unit (.path + restart oneshot)
// ---------------------------------------------------------------------------

describe('installSystemdService — .path unit', () => {
  it('writes .path + restart oneshot when watchPaths are returned, enables path unit', async () => {
    // Override resolveWatchPaths to return a dev-tree path so the .path branch fires.
    const plist = await import('../launchd/plist.js');
    const spy = vi.spyOn(plist, 'resolveWatchPaths').mockReturnValueOnce([
      `${HOME}/dev/agent-afk/dist/telegram.mjs`,
    ]);

    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    spy.mockRestore();

    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') {
      expect(result.autoRestartOnRebuild).toBe(true);
    }
    // Both .path and restart oneshot must have been written.
    expect(atomicWritten.has(pathUnitPath('telegram'))).toBe(true);
    expect(atomicWritten.has(restartUnitPath('telegram'))).toBe(true);

    // systemctl enable --now must be called for the .path unit.
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user enable --now afk-telegram.path'))).toBe(true);
  });

  it('rolls back ALL units when restart-unit write fails', async () => {
    const plist = await import('../launchd/plist.js');
    const spy = vi.spyOn(plist, 'resolveWatchPaths').mockReturnValueOnce([
      `${HOME}/dev/agent-afk/dist/telegram.mjs`,
    ]);

    // First atomicWriteFile call (service unit) succeeds, second (restart unit) throws.
    let callIdx = 0;
    mockAtomicWriteFile.mockImplementation((_path: string, content: string) => {
      if (callIdx++ === 1) throw new Error('write restart unit failed');
      atomicWritten.set(_path, content as string);
      mockExistsSyncStore.add(_path);
    });

    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    spy.mockRestore();

    expect(result.kind).toBe('failed');
    // Rollback must have been triggered.
    expect(mockRmSyncCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// uninstallSystemdService
// ---------------------------------------------------------------------------

describe('uninstallSystemdService', () => {
  it('returns not-installed when unit file does not exist', () => {
    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('not-installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('disables unit, removes it, daemon-reloads, returns uninstalled', () => {
    const p = unitPath('telegram');
    seedFile(p);

    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('uninstalled');
    if (result.kind === 'uninstalled') {
      expect(result.configPath).toBe(p);
    }

    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user disable --now afk-telegram.service'))).toBe(true);
    expect(calls.some((a) => a.includes('--user daemon-reload'))).toBe(true);
  });

  it('also disables and removes the companion .path unit when present', () => {
    seedFile(unitPath('telegram'));
    seedFile(pathUnitPath('telegram'));

    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('uninstalled');

    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user disable --now afk-telegram.path'))).toBe(true);
  });

  it('continues past disable failures and still removes the file', () => {
    const p = unitPath('telegram');
    seedFile(p);
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('disable')) throw new Error('not loaded');
      return Buffer.from('');
    });

    const result = uninstallSystemdService('telegram');
    // disable failure is non-fatal — file still removed.
    expect(result.kind).toBe('uninstalled');
  });

  it('removes companion restart oneshot when present', () => {
    seedFile(unitPath('telegram'));
    seedFile(restartUnitPath('telegram'));

    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('uninstalled');
    // restart unit removed via rmSync.
    const rp = restartUnitPath('telegram');
    expect(mockRmSyncCalls.some((p) => p === rp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readUnitFile
// ---------------------------------------------------------------------------

describe('readUnitFile', () => {
  it('returns undefined when the unit file does not exist', () => {
    expect(readUnitFile('telegram')).toBeUndefined();
  });

  it('returns the unit file contents when the file exists', () => {
    const p = unitPath('telegram');
    seedFile(p);
    mockReadFileSync.mockReturnValue('[Unit]\nDescription=AFK telegram service\n');
    const result = readUnitFile('telegram');
    expect(result).toBe('[Unit]\nDescription=AFK telegram service\n');
  });

  it('works for the daemon service as well', () => {
    const p = unitPath('daemon');
    seedFile(p);
    mockReadFileSync.mockReturnValue('[Unit]\nDescription=AFK daemon service\n');
    expect(readUnitFile('daemon')).toContain('AFK daemon service');
  });
});
