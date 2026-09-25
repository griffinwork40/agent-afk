// Windows: .mjs dynamic import of scripts/postinstall.mjs fails on Windows (#703)
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const isWin32 = process.platform === 'win32';

type KillStaleDaemonFn = (pidFilePath: string, killFn?: (pid: number, signal: string) => void) => void;
type IsManualBotRunningFn = (
  pidFilePath: string,
  probeFn?: (pid: number, signal: number) => void,
) => number | null;
type RestartLaunchdServicesFn = (opts?: {
  home?: string;
  uid?: number;
  labels?: string[];
  existsFn?: (p: string) => boolean;
  execFn?: (argv: string[]) => void;
}) => string[];
type IsGlobalInstallFn = (
  pkgRoot: string,
  env?: Record<string, string | undefined>,
  existsFn?: (p: string) => boolean,
) => boolean;
type IsMainModuleFn = (metaUrl: string, argv1?: string) => boolean;

let killStaleDaemon: KillStaleDaemonFn;
let isManualBotRunning: IsManualBotRunningFn;
let restartLaunchdServices: RestartLaunchdServicesFn;
let isGlobalInstall: IsGlobalInstallFn;
let isMainModule: IsMainModuleFn;

beforeAll(async () => {
  // Dynamic import avoids TypeScript transform issues with plain .mjs files.
  // Pattern mirrors src/cli/postinstall.test.ts exactly.
  const mod = await import('../scripts/postinstall.mjs');
  killStaleDaemon = mod.killStaleDaemon as KillStaleDaemonFn;
  isManualBotRunning = mod.isManualBotRunning as IsManualBotRunningFn;
  restartLaunchdServices = mod.restartLaunchdServices as RestartLaunchdServicesFn;
  isGlobalInstall = mod.isGlobalInstall as IsGlobalInstallFn;
  isMainModule = mod.isMainModule as IsMainModuleFn;
});

describe.skipIf(isWin32)('killStaleDaemon', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-kill-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('silently returns when PID file does not exist', () => {
    const missing = join(tmpDir, 'no-such.pid');
    expect(() => killStaleDaemon(missing)).not.toThrow();
  });

  it('silently returns when PID file contains non-numeric content', () => {
    const pidFile = join(tmpDir, 'garbage.pid');
    writeFileSync(pidFile, 'not-a-pid');
    const killFn = vi.fn();
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
    expect(killFn).not.toHaveBeenCalled();
  });

  it('silently returns when process.kill throws ESRCH (process not found)', () => {
    const pidFile = join(tmpDir, 'stale.pid');
    writeFileSync(pidFile, '999999999');
    const killFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
  });

  it('calls killFn(pid, "SIGTERM") when PID file contains a valid numeric PID', () => {
    const pidFile = join(tmpDir, 'live.pid');
    writeFileSync(pidFile, '12345');
    const killFn = vi.fn();
    killStaleDaemon(pidFile, killFn);
    expect(killFn).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('silently returns when killFn throws EPERM (cross-user permission denied)', () => {
    const pidFile = join(tmpDir, 'other-user.pid');
    writeFileSync(pidFile, '42');
    const killFn = vi.fn(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => killStaleDaemon(pidFile, killFn)).not.toThrow();
    expect(killFn).toHaveBeenCalledWith(42, 'SIGTERM');
  });
});

describe.skipIf(isWin32)('isManualBotRunning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-botprobe-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null when the PID file does not exist', () => {
    const missing = join(tmpDir, 'no-such.pid');
    const probeFn = vi.fn();
    expect(isManualBotRunning(missing, probeFn)).toBeNull();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('returns null (and never probes) for non-numeric PID content', () => {
    const pidFile = join(tmpDir, 'garbage.pid');
    writeFileSync(pidFile, 'not-a-pid');
    const probeFn = vi.fn();
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('returns the PID and probes with signal 0 when the process is alive', () => {
    const pidFile = join(tmpDir, 'live.pid');
    writeFileSync(pidFile, '4321');
    const probeFn = vi.fn(); // no throw = process exists
    expect(isManualBotRunning(pidFile, probeFn)).toBe(4321);
    expect(probeFn).toHaveBeenCalledWith(4321, 0);
  });

  it('returns null when the probe throws ESRCH (stale PID, process gone)', () => {
    const pidFile = join(tmpDir, 'stale.pid');
    writeFileSync(pidFile, '999999999');
    const probeFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
  });

  it('returns null when the probe throws EPERM (process owned by another user)', () => {
    const pidFile = join(tmpDir, 'other.pid');
    writeFileSync(pidFile, '42');
    const probeFn = vi.fn(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(isManualBotRunning(pidFile, probeFn)).toBeNull();
  });

  it('does NOT delete a stale PID file (read-only, unlike manager.isRunning)', () => {
    const pidFile = join(tmpDir, 'stale-keep.pid');
    writeFileSync(pidFile, '999999999');
    const probeFn = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    isManualBotRunning(pidFile, probeFn);
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe.skipIf(isWin32)('restartLaunchdServices', () => {
  const HOME = '/Users/tester';
  const TELEGRAM_PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.afk.telegram.plist');
  const DAEMON_PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.afk.daemon.plist');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] and never shells out when no service plist exists', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      existsFn: () => false,
      execFn,
    });
    expect(result).toEqual([]);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('restarts only services whose plist exists, with the correct kickstart argv', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      existsFn: (p) => p === TELEGRAM_PLIST, // only telegram installed
      execFn,
    });
    expect(result).toEqual(['com.afk.telegram']);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledWith(['kickstart', '-k', 'gui/1000/com.afk.telegram']);
  });

  it('restarts both services when both plists exist', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 501,
      existsFn: (p) => p === TELEGRAM_PLIST || p === DAEMON_PLIST,
      execFn,
    });
    expect(result).toEqual(['com.afk.telegram', 'com.afk.daemon']);
    expect(execFn).toHaveBeenNthCalledWith(1, ['kickstart', '-k', 'gui/501/com.afk.telegram']);
    expect(execFn).toHaveBeenNthCalledWith(2, ['kickstart', '-k', 'gui/501/com.afk.daemon']);
  });

  it('swallows a launchctl error for one service and still attempts the other', () => {
    const execFn = vi.fn((argv: string[]) => {
      if (argv[2]?.endsWith('com.afk.telegram')) {
        throw new Error('Could not find service'); // not loaded
      }
    });
    const result = restartLaunchdServices({
      home: HOME,
      uid: 501,
      existsFn: () => true, // both plists present
      execFn,
    });
    // telegram threw → excluded; daemon succeeded → included. No throw.
    expect(result).toEqual(['com.afk.daemon']);
    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it('honours a custom labels list', () => {
    const execFn = vi.fn();
    const result = restartLaunchdServices({
      home: HOME,
      uid: 1000,
      labels: ['com.afk.daemon'],
      existsFn: (p) => p === DAEMON_PLIST,
      execFn,
    });
    expect(result).toEqual(['com.afk.daemon']);
    expect(execFn).toHaveBeenCalledWith(['kickstart', '-k', 'gui/1000/com.afk.daemon']);
  });
});

// ─── isGlobalInstall ─────────────────────────────────────────────────────────
// Tests verify the global-install guard introduced to prevent daemon restarts
// during local `pnpm install` runs inside source checkouts and worktrees.
// All tests inject pkgRoot, env, and existsFn so no real filesystem or npm
// lifecycle environment leaks into the assertions.
describe.skipIf(isWin32)('isGlobalInstall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-globalinstall-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns true when npm_config_global is "true" and no .git marker exists', () => {
    // Simulates: npm install -g agent-afk landing under a global node_modules.
    const env = { npm_config_global: 'true' };
    const noGit = (_p: string) => false; // no .git
    expect(isGlobalInstall(tmpDir, env, noGit)).toBe(true);
  });

  it('returns false when npm_config_global is absent', () => {
    // Simulates: plain `pnpm install` in any local context.
    const env: Record<string, string | undefined> = {};
    const noGit = (_p: string) => false;
    expect(isGlobalInstall(tmpDir, env, noGit)).toBe(false);
  });

  it('returns false when npm_config_global is "false"', () => {
    const env = { npm_config_global: 'false' };
    const noGit = (_p: string) => false;
    expect(isGlobalInstall(tmpDir, env, noGit)).toBe(false);
  });

  it('returns false when npm_config_global is "true" but .git marker exists (source checkout)', () => {
    // Belt-and-suspenders: even if npm_config_global were somehow set to "true"
    // inside a repo (e.g. a misconfigured CI job), the .git marker prevents restart.
    const gitDir = join(tmpDir, '.git');
    mkdirSync(gitDir);
    const env = { npm_config_global: 'true' };
    // Use real existsSync — .git dir was just created in tmpDir.
    expect(isGlobalInstall(tmpDir, env, existsSync)).toBe(false);
  });

  it('returns false when .git is a file (managed git worktree)', () => {
    // Worktrees use a .git FILE pointing back to the main tree, not a directory.
    const gitFile = join(tmpDir, '.git');
    writeFileSync(gitFile, 'gitdir: /some/main/worktree/.git/worktrees/branch\n');
    const env = { npm_config_global: 'true' };
    expect(isGlobalInstall(tmpDir, env, existsSync)).toBe(false);
  });

  it('returns false when npm_config_global is undefined (not set at all)', () => {
    const env: Record<string, string | undefined> = { npm_config_global: undefined };
    const noGit = (_p: string) => false;
    expect(isGlobalInstall(tmpDir, env, noGit)).toBe(false);
  });
});

// ─── isMainModule ─────────────────────────────────────────────────────────────
// Tests verify the latent bug fixed in #2198: the raw `file://${argv1}` comparison
// returns false when the install path contains URL-encoding-required characters
// (spaces, non-ASCII). isMainModule() uses fileURLToPath + realpathSync so the
// comparison is always on decoded, symlink-resolved absolute paths.
describe.skipIf(isWin32)('isMainModule', () => {
  it('returns false when argv1 is undefined', () => {
    expect(isMainModule('file:///some/path/script.mjs', undefined)).toBe(false);
  });

  it('returns false when argv1 is an empty string', () => {
    expect(isMainModule('file:///some/path/script.mjs', '')).toBe(false);
  });

  it('returns true when metaUrl and argv1 refer to the same real path', async () => {
    // Use import.meta.url of THIS test file and its resolved path — both are
    // guaranteed to exist on disk so realpathSync succeeds and the comparison
    // exercises the happy path.
    const thisFile = new URL(import.meta.url);
    // fileURLToPath(import.meta.url) is the real path of this test file.
    const { fileURLToPath: fup } = await import('node:url');
    const realPath = fup(thisFile);
    expect(isMainModule(import.meta.url, realPath)).toBe(true);
  });

  it('returns false when metaUrl and argv1 refer to different files', () => {
    expect(
      isMainModule('file:///some/path/script.mjs', '/other/path/different.mjs'),
    ).toBe(false);
  });

  it('handles a space-containing path without throwing (the URL-encoding bug)', () => {
    // This is the latent bug fixed by #2198. Previously:
    //   import.meta.url === `file://${process.argv[1]}`
    // would compare "file:///my%20dir/script.mjs" with "file:///my dir/script.mjs"
    // and return false even when they represent the same file.
    //
    // The fix uses fileURLToPath on metaUrl and realpathSync on argv1.
    // Since argv1 does not exist on disk, realpathSync throws; isMainModule()
    // catches and falls back to comparing fileURLToPath(metaUrl) === argv1.
    // Both sides are now raw paths, so the comparison is correct.
    const spaceUrl = 'file:///my%20dir/script.mjs';
    const rawPath = '/my dir/script.mjs'; // same path, not URL-encoded
    expect(isMainModule(spaceUrl, rawPath)).toBe(true);
  });

  it('handles non-ASCII characters in the path without throwing', () => {
    const encodedUrl = 'file:///home/caf%C3%A9/script.mjs'; // café
    const rawPath = '/home/café/script.mjs';
    expect(isMainModule(encodedUrl, rawPath)).toBe(true);
  });

  it('returns false for a non-existent argv1 that does not match', () => {
    expect(
      isMainModule('file:///real/script.mjs', '/nonexistent/other.mjs'),
    ).toBe(false);
  });
});
