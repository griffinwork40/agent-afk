/**
 * Tests for src/cli/commands/update.ts
 *
 * Covers:
 *   - `afk update --check`: cold cache (network fetch), up-to-date, update available
 *   - `afk update --pin <version>`: semver validation, happy path, install-failure
 *   - `afk update` (latest): fetches and installs
 *   - `runNpmInstall` signal-kill path (via exit event)
 *   - Fix A: resolveNpmBinary — uses npm sibling to the running Node, not PATH npm
 *   - Fix B: service restart after successful install; --no-restart; loud warning on failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../version.js', () => ({
  getVersion: vi.fn(() => '1.10.1'),
}));

vi.mock('../update-checker.js', () => ({
  fetchLatestVersion: vi.fn(),
  writePendingUpdateMarker: vi.fn(),
  writeUpdateCache: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../palette.js', () => ({
  palette: {
    bold: (s: string) => s,
    dim: (s: string) => s,
    warning: (s: string) => s,
    success: (s: string) => s,
    info: (s: string) => s,
  },
}));

// Mock fs.existsSync so resolveNpmBinary's sibling-lookup falls back to
// bare 'npm' in existing tests (preserves pre-existing spawn assertions).
const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn(() => false) }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

// Mock service manager — fix B tests
const { mockServiceManager } = vi.hoisted(() => {
  const mgr = {
    backend: 'launchd' as const,
    configKind: 'LaunchAgent plist',
    isInstalled: vi.fn(() => false),
    restart: vi.fn(() => ({ kind: 'restarted' as const, label: 'com.afk.daemon' })),
    install: vi.fn(),
    uninstall: vi.fn(),
    status: vi.fn(),
    upgrade: vi.fn(),
    configPath: vi.fn((name: string) => `/fake/${name}.plist`),
    logPath: vi.fn(),
    label: vi.fn(),
    readConfigFile: vi.fn(),
  };
  return { mockServiceManager: mgr };
});
vi.mock('../../service/index.js', () => ({
  serviceManagerFor: () => mockServiceManager,
  SERVICE_NAMES: ['telegram', 'daemon'],
}));

import { spawn } from 'child_process';
import { fetchLatestVersion, writePendingUpdateMarker, writeUpdateCache } from '../update-checker.js';
import { registerUpdateCommand, resolveNpmBinary } from './update.js';
import { EventEmitter } from 'events';

const mockFetchLatestVersion = vi.mocked(fetchLatestVersion);
const mockWritePendingUpdateMarker = vi.mocked(writePendingUpdateMarker);
const mockWriteUpdateCache = vi.mocked(writeUpdateCache);
const mockSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `afk update [args...]` through Commander and return after the action resolves. */
async function runUpdate(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerUpdateCommand(program);
  await program.parseAsync(['node', 'afk', 'update', ...args]);
}

/**
 * Returns a spawn mock implementation that emits 'exit' after the listener
 * has been registered (via setImmediate to allow synchronous `.on()` setup).
 */
function spawnExiting(code: number | null, signal: NodeJS.Signals | null = null) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setImmediate(() => child.emit('exit', code, signal));
    return child;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk update', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // existsSync: default false so resolveNpmBinary falls back to 'npm'
    mockExistsSync.mockReturnValue(false);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    originalExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  // -------------------------------------------------------------------------
  // --check
  // -------------------------------------------------------------------------

  describe('--check', () => {
    it('reports update available when registry returns a newer version (cold cache)', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      await runUpdate('--check');

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Update available');
      expect(output).toContain('1.10.1');
      expect(output).toContain('1.12.0');
      // B: --check refreshes the notifier cache with what it learned.
      expect(mockWriteUpdateCache).toHaveBeenCalledWith('1.12.0');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports up to date when registry returns the current version', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.10.1');
      await runUpdate('--check');

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('up to date');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports up to date when registry returns an older version', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.9.0');
      await runUpdate('--check');

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('up to date');
      expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode=1 and prints a warning when registry is unreachable', async () => {
      mockFetchLatestVersion.mockResolvedValue(undefined);
      await runUpdate('--check');

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Could not reach');
      expect(process.exitCode).toBe(1);
    });

    it('does not call spawn (npm install) during --check', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      await runUpdate('--check');
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // --pin
  // -------------------------------------------------------------------------

  describe('--pin', () => {
    it('rejects a non-semver --pin value without calling npm', async () => {
      await runUpdate('--pin', 'bad-version!!');

      const output = consoleErrSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Invalid version');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('rejects a shell-injection --pin value without calling npm', async () => {
      await runUpdate('--pin', '1.0.0; rm -rf /');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('installs the pinned version on happy path', async () => {
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      await runUpdate('--pin', '1.11.0');

      expect(mockSpawn).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', '--allow-scripts=agent-afk', 'agent-afk@1.11.0'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      expect(mockWritePendingUpdateMarker).toHaveBeenCalledWith('1.11.0');
      // B: an explicit --pin must NOT touch the notifier cache — it may target
      // an older-than-latest version and would otherwise poison the banner.
      expect(mockWriteUpdateCache).not.toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('installed');
      expect(process.exitCode).toBeUndefined();
    });

    it('accepts pre-release versions for --pin', async () => {
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      await runUpdate('--pin', '2.0.0-beta.1');

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockWritePendingUpdateMarker).toHaveBeenCalledWith('2.0.0-beta.1');
    });

    it('propagates non-zero exit code from npm install', async () => {
      mockSpawn.mockImplementation(spawnExiting(1) as unknown as typeof spawn);
      await runUpdate('--pin', '1.11.0');

      expect(mockWritePendingUpdateMarker).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('reports signal kill separately from non-zero exit code', async () => {
      mockSpawn.mockImplementation(spawnExiting(null, 'SIGKILL') as unknown as typeof spawn);
      await runUpdate('--pin', '1.11.0');

      const errOutput = consoleErrSpy.mock.calls.flat().join('\n');
      expect(errOutput).toContain('SIGKILL');
      expect(mockWritePendingUpdateMarker).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Default (no flags): fetches latest and installs
  // -------------------------------------------------------------------------

  describe('default (no flags)', () => {
    it('fetches latest version and installs when newer', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);

      await runUpdate();

      expect(mockFetchLatestVersion).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', '--allow-scripts=agent-afk', 'agent-afk@1.12.0'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      expect(mockWritePendingUpdateMarker).toHaveBeenCalledWith('1.12.0');
      // B: the fetched-latest install path refreshes the notifier cache.
      expect(mockWriteUpdateCache).toHaveBeenCalledWith('1.12.0');
    });

    it('prints up-to-date and skips install when already on latest', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.10.1');

      await runUpdate();

      expect(mockSpawn).not.toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('up to date');
      // B: even when already current, we refresh the cache with the fetched
      // latest so the banner stops offering an install we don't need.
      expect(mockWriteUpdateCache).toHaveBeenCalledWith('1.10.1');
    });

    it('sets exitCode=1 when registry is unreachable', async () => {
      mockFetchLatestVersion.mockResolvedValue(undefined);

      await runUpdate();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Fix A: resolveNpmBinary
  // -------------------------------------------------------------------------

  describe('resolveNpmBinary (fix A)', () => {
    it('returns sibling npm when it exists next to the node binary', () => {
      const execPath = '/opt/homebrew/bin/node';
      const existsFn = (p: string) => p === '/opt/homebrew/bin/npm';
      const result = resolveNpmBinary(execPath, 'linux', existsFn);
      expect(result).toBe('/opt/homebrew/bin/npm');
    });

    it('falls back to bare "npm" when no sibling exists', () => {
      const result = resolveNpmBinary('/some/custom/bin/node', 'linux', () => false);
      expect(result).toBe('npm');
    });

    it('uses npm.cmd on Windows when sibling exists (POSIX-path variant)', () => {
      const execPath = '/c/nodejs/node.exe';
      const existsFn = (p: string) => p === '/c/nodejs/npm.cmd';
      const result = resolveNpmBinary(execPath, 'win32', existsFn);
      expect(result).toBe('/c/nodejs/npm.cmd');
    });

    it('falls back to "npm.cmd" on Windows when sibling missing', () => {
      expect(resolveNpmBinary('/c/nodejs/node.exe', 'win32', () => false)).toBe('npm.cmd');
    });

    it('uses nvm-local npm when node lives under nvm', () => {
      const execPath = '/Users/me/.nvm/versions/node/v24.11.0/bin/node';
      const existsFn = (p: string) => p === '/Users/me/.nvm/versions/node/v24.11.0/bin/npm';
      expect(resolveNpmBinary(execPath, 'linux', existsFn))
        .toBe('/Users/me/.nvm/versions/node/v24.11.0/bin/npm');
    });
  });

  // -------------------------------------------------------------------------
  // Fix B: restart services after successful install
  // -------------------------------------------------------------------------

  describe('service restart after install (fix B)', () => {
    it('restarts installed services after a successful install', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      mockServiceManager.isInstalled.mockImplementation((name: string) => name === 'daemon');
      mockServiceManager.restart.mockReturnValue({ kind: 'restarted', label: 'com.afk.daemon' });

      await runUpdate();

      expect(mockServiceManager.restart).toHaveBeenCalledTimes(1);
      expect(mockServiceManager.restart).toHaveBeenCalledWith('daemon');
      expect(process.exitCode).toBeUndefined();
    });

    it('warns and sets exitCode=2 on restart failure without failing the update', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      mockServiceManager.isInstalled.mockImplementation((name: string) => name === 'daemon');
      mockServiceManager.restart.mockReturnValue({
        kind: 'failed',
        reason: 'spawnSync launchctl ETIMEDOUT',
      });

      await runUpdate();

      const errCalls = consoleErrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(errCalls).toMatch(/daemon/);
      expect(errCalls).toMatch(/ETIMEDOUT/);
      expect(errCalls).toMatch(/afk service restart daemon/);
      // exitCode = 2 (restart failed) not 1 (install failed)
      expect(process.exitCode).toBe(2);
    });

    it('skips service restart when --no-restart is passed', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      mockServiceManager.isInstalled.mockReturnValue(true);

      await runUpdate('--no-restart');

      expect(mockServiceManager.restart).not.toHaveBeenCalled();
    });

    it('does not restart services when npm install fails', async () => {
      mockFetchLatestVersion.mockResolvedValue('1.12.0');
      mockSpawn.mockImplementation(spawnExiting(1) as unknown as typeof spawn);
      mockServiceManager.isInstalled.mockReturnValue(true);

      await runUpdate();

      expect(mockServiceManager.restart).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
