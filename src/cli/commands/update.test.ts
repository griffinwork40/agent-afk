/**
 * Tests for src/cli/commands/update.ts
 *
 * Covers:
 *   - `afk update --check`: cold cache (network fetch), up-to-date, update available
 *   - `afk update --pin <version>`: semver validation, happy path, install-failure
 *   - `afk update` (latest): fetches and installs
 *   - `runNpmInstall` signal-kill path (via exit event)
 *   - npm CLI binding to the running Node, never inherited PATH's Node
 *   - safe service handoff and lifecycle suppression for --no-restart
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

// No host filesystem dependency, including Homebrew's sibling npm symlink.
const { mockExistsSync, mockRealpathSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockRealpathSync: vi.fn((p: string) => p),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync, realpathSync: mockRealpathSync };
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

import path from 'path';
import { spawn } from 'child_process';
import { fetchLatestVersion, writePendingUpdateMarker, writeUpdateCache } from '../update-checker.js';
import { registerUpdateCommand, resolveNpmCli } from './update.js';
import { getVersion } from '../version.js';
import { EventEmitter } from 'events';

const mockFetchLatestVersion = vi.mocked(fetchLatestVersion);
const mockWritePendingUpdateMarker = vi.mocked(writePendingUpdateMarker);
const mockWriteUpdateCache = vi.mocked(writeUpdateCache);
const mockSpawn = vi.mocked(spawn);
const mockGetVersion = vi.mocked(getVersion);

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
    // npm CLI exists in the running Node installation unless a test overrides it.
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
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

    it('--check reports update available when running a prerelease of the same core as latest', async () => {
      // isPrerelease hardening: a running 1.10.1-rc.1 should be offered 1.10.1.
      // The earlier `v.includes('-')` logic handled this correctly but the new
      // regex must too — this test guards both the old and new code path.
      mockGetVersion.mockReturnValueOnce('1.10.1-rc.1');
      mockFetchLatestVersion.mockResolvedValue('1.10.1');
      await runUpdate('--check');
      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Update available');
      expect(output).toContain('1.10.1');
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
        process.execPath,
        [resolveNpmCli(), 'install', '-g', '--allow-scripts=agent-afk', 'agent-afk@1.11.0'],
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
        process.execPath,
        [resolveNpmCli(), 'install', '-g', '--allow-scripts=agent-afk', 'agent-afk@1.12.0'],
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

  describe('npm interpreter binding', () => {
    it('resolves Homebrew sibling symlinks into the shared npm installation', () => {
      const execPath = path.join(path.sep, 'opt', 'homebrew', 'Cellar', 'node', '26.11.0', 'bin', 'node');
      const sibling = path.join(path.dirname(execPath), 'npm');
      const npmCli = path.join(path.sep, 'opt', 'homebrew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      expect(resolveNpmCli(execPath, (p) => p === sibling || p === npmCli, () => npmCli)).toBe(npmCli);
    });

    it('does not execute a sibling shell wrapper as JavaScript', () => {
      const execPath = path.join(path.sep, 'nodejs', 'node');
      expect(resolveNpmCli(execPath, () => true, (p) => p)).toMatch(/npm-cli\.js$/);
    });
    it.each(['homebrew', 'nvm'])('locates the POSIX npm CLI for %s layouts', (prefix) => {
      const execPath = path.join(path.sep, prefix, 'bin', 'node');
      const npmCli = path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      expect(resolveNpmCli(execPath, (p) => p === npmCli)).toBe(npmCli);
    });

    it('locates the Windows npm CLI without using a cmd launcher', () => {
      const execPath = path.join(path.sep, 'nodejs', 'node.exe');
      const npmCli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      expect(resolveNpmCli(execPath, (p) => p === npmCli)).toBe(npmCli);
    });

    it('does not fall back to an unrelated PATH npm', async () => {
      mockExistsSync.mockReturnValue(false);
      await runUpdate('--pin', '1.11.0');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy.mock.calls.flat().join('\n')).toContain('different global prefix');
    });

    it('executes the npm CLI directly with this Node rather than its env-node shebang', async () => {
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
      await runUpdate('--pin', '1.11.0');
      expect(mockSpawn.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(mockSpawn.mock.calls[0]?.[1]?.[0]).toMatch(/npm-cli\.js$/);
    });
  });

  describe('service handoff safety', () => {
    beforeEach(() => {
      mockServiceManager.isInstalled.mockReturnValue(true);
      mockSpawn.mockImplementation(spawnExiting(0) as unknown as typeof spawn);
    });

    it('never immediately restarts Telegram, even when installed and busy', async () => {
      await runUpdate('--pin', '1.11.0');
      expect(mockServiceManager.restart).not.toHaveBeenCalledWith('telegram');
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('idle-aware watchdog');
    });

    it('never reconciles definitions using the old in-memory service renderer', async () => {
      await runUpdate('--pin', '1.11.0');
      expect(mockServiceManager.restart).not.toHaveBeenCalled();
      expect(mockServiceManager.upgrade).not.toHaveBeenCalled();
      expect(mockServiceManager.isInstalled).not.toHaveBeenCalled();
      // Normal installs still permit the NEW package's lifecycle to reconcile.
      expect(mockSpawn.mock.calls[0]?.[1]).not.toContain('--ignore-scripts');
    });

    it.each(['1.11.0', '1.0.0'])('--no-restart suppresses lifecycle scripts even when pinning %s', async (version) => {
      await runUpdate('--no-restart', '--pin', version);
      expect(mockSpawn.mock.calls[0]?.[1]).toContain('--ignore-scripts');
      expect(mockServiceManager.restart).not.toHaveBeenCalled();
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('Idle version watchdogs remain active');
    });

    it.each([false, true])('displays the actual npm lifecycle flags (noRestart=%s)', async (noRestart) => {
      await runUpdate(...(noRestart ? ['--no-restart'] : []), '--pin', '1.11.0');
      const args = mockSpawn.mock.calls[0]?.[1];
      expect(args).toBeDefined();
      expect(consoleSpy).toHaveBeenCalledWith(`  ${process.execPath} ${args!.join(' ')}`);
      expect(args).toContain('--allow-scripts=agent-afk');
      expect(args!.includes('--ignore-scripts')).toBe(noRestart);
    });

    it('does not restart services when npm install fails', async () => {
      mockSpawn.mockImplementation(spawnExiting(1) as unknown as typeof spawn);
      await runUpdate('--pin', '1.11.0');
      expect(mockServiceManager.restart).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
