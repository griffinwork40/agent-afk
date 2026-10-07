/**
 * Unit tests for `src/cli/commands/service.ts` (COV-007).
 *
 * Strategy: mock the `src/service/index.ts` backend and
 * `src/cli/errors/index.ts` so we can drive every subcommand's action
 * handler via Commander `parseAsync` without touching launchd, systemd,
 * or any real OS.  process.exit is intercepted to prevent the test
 * process from dying.
 *
 * Per POSIX guard R4: no test is gated on `process.platform`.
 */

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any SUT import.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const install = vi.fn();
  const uninstall = vi.fn();
  const status = vi.fn();
  const restart = vi.fn();
  const upgrade = vi.fn();
  const isInstalled = vi.fn();
  const configPath = vi.fn();
  const logPath = vi.fn();
  const label = vi.fn();
  const readConfigFile = vi.fn();
  const serviceManagerFor = vi.fn();
  const handleCommandError = vi.fn();

  return {
    install, uninstall, status, restart, upgrade,
    isInstalled, configPath, logPath, label, readConfigFile,
    serviceManagerFor, handleCommandError,
  };
});

vi.mock('../../../src/service/index.js', () => ({
  SERVICE_NAMES: ['telegram', 'daemon'] as const,
  SUPPORTED_SERVICE_PLATFORMS: 'macOS (launchd), Linux (systemd --user), and Windows (Task Scheduler)',
  serviceManagerFor: mocks.serviceManagerFor,
}));

vi.mock('../../../src/cli/errors/index.js', () => ({
  handleCommandError: mocks.handleCommandError,
}));

// palette: strip colors so assertions are on plain text.
vi.mock('../../../src/cli/palette.js', () => ({
  palette: {
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    meta: (s: string) => s,
    info: (s: string) => s,
    dim: (s: string) => s,
    heading: (s: string) => s,
  },
}));

// SUT imported after mocks.
import { registerServiceCommand } from '../../../src/cli/commands/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured stdout/stderr writes per test. */
let logLines: string[] = [];
let errLines: string[] = [];

/** Build a fresh Commander program with the service command registered. */
function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride(); // prevent Commander from calling process.exit
  registerServiceCommand(prog);
  return prog;
}

/** Stub service manager returned by serviceManagerFor. */
function makeManager(overrides: Partial<typeof mocks> = {}): object {
  return {
    backend: 'launchd',
    configKind: 'LaunchAgent plist',
    install: overrides.install ?? mocks.install,
    uninstall: overrides.uninstall ?? mocks.uninstall,
    status: overrides.status ?? mocks.status,
    restart: overrides.restart ?? mocks.restart,
    upgrade: overrides.upgrade ?? mocks.upgrade,
    isInstalled: overrides.isInstalled ?? mocks.isInstalled,
    configPath: overrides.configPath ?? mocks.configPath,
    logPath: overrides.logPath ?? mocks.logPath,
    label: overrides.label ?? mocks.label,
    readConfigFile: overrides.readConfigFile ?? mocks.readConfigFile,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logLines = [];
  errLines = [];

  // Reset all mock call histories first (before re-installing implementations).
  vi.clearAllMocks();

  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logLines.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errLines.push(args.join(' '));
  });
  // process.exit: record the call but do not throw and do not terminate the
  // process.  Action handlers have try/catch blocks that call handleCommandError
  // (itself mocked) — if process.exit threw, the throw would be re-caught by
  // that block and swallowed, making rejects.toThrow() assertions unreliable.
  // Instead we just assert exitSpy was called with the expected code.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(
    (_code?: number | string | null) => undefined as never,
  );

  // Default: platform supported → return a manager.
  mocks.serviceManagerFor.mockReturnValue(makeManager());
  mocks.logPath.mockReturnValue('/fake/logs/telegram.log');
  mocks.label.mockReturnValue('AFK Telegram Bot');
  mocks.configPath.mockReturnValue('/fake/LaunchAgents/com.afk.telegram.plist');
  mocks.isInstalled.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveManager — unsupported platform
// ---------------------------------------------------------------------------

describe('resolveManager — unsupported platform', () => {
  it('calls handleCommandError with a "not supported" message when platform is unknown', async () => {
    mocks.serviceManagerFor.mockReturnValue(null);
    const prog = makeProgram();
    // handleCommandError is mocked so it swallows the error without throwing;
    // the parse itself resolves normally from Commander's perspective.
    await prog.parseAsync(['service', 'list'], { from: 'user' });
    expect(mocks.handleCommandError).toHaveBeenCalled();
    const err = mocks.handleCommandError.mock.calls[0]?.[0] as Error;
    expect(err.message).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// parseServiceName — validation
// ---------------------------------------------------------------------------

describe('parseServiceName — invalid name', () => {
  it('calls handleCommandError for an unknown service name', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'notaservice'], { from: 'user' });
    expect(mocks.handleCommandError).toHaveBeenCalled();
    const err = mocks.handleCommandError.mock.calls[0]?.[0] as Error;
    expect(err.message).toMatch(/notaservice/);
  });
});

// ---------------------------------------------------------------------------
// service install
// ---------------------------------------------------------------------------

describe('service install', () => {
  it('prints success when install returns kind=installed', async () => {
    mocks.install.mockReturnValue({
      kind: 'installed',
      label: 'AFK Telegram Bot',
      configPath: '/fake/LaunchAgents/com.afk.telegram.plist',
      autoRestartOnRebuild: true,
      notes: [],
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Installed');
    expect(all).toContain('Config:');
    expect(all).toContain('Log:');
    expect(all).toContain('Auto-restart on rebuild: on');
    expect(all).toContain('afk service status telegram');
  });

  it('prints auto-restart-off message when autoRestartOnRebuild is false', async () => {
    mocks.install.mockReturnValue({
      kind: 'installed',
      label: 'AFK Daemon',
      configPath: '/fake/LaunchAgents/com.afk.daemon.plist',
      autoRestartOnRebuild: false,
    });
    mocks.logPath.mockReturnValue('/fake/logs/daemon.log');
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'daemon'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain("Auto-restart on rebuild: off");
  });

  it('prints notes from the install result', async () => {
    mocks.install.mockReturnValue({
      kind: 'installed',
      label: 'AFK Telegram Bot',
      configPath: '/fake/plist',
      autoRestartOnRebuild: false,
      notes: ['Enable lingering: loginctl enable-linger'],
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Enable lingering');
  });

  it('exits 1 when install returns already-installed', async () => {
    mocks.install.mockReturnValue({
      kind: 'already-installed',
      label: 'AFK Telegram Bot',
      configPath: '/fake/LaunchAgents/com.afk.telegram.plist',
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const all = logLines.join('\n');
    expect(all).toContain('already installed');
  });

  it('exits 1 when install returns failed', async () => {
    mocks.install.mockReturnValue({ kind: 'failed', reason: 'permission denied' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('permission denied');
  });

  it('passes --dry-run flag to the manager', async () => {
    mocks.install.mockReturnValue({
      kind: 'installed',
      label: 'AFK Telegram Bot',
      configPath: '/fake/plist',
      autoRestartOnRebuild: false,
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram', '--dry-run'], { from: 'user' });
    expect(mocks.install).toHaveBeenCalledWith('telegram', expect.objectContaining({ dryRun: true }));
    // Status hint suppressed in dry-run mode
    expect(logLines.join('\n')).not.toContain('afk service status');
  });

  it('passes --no-watch flag to the manager', async () => {
    mocks.install.mockReturnValue({
      kind: 'installed',
      label: 'AFK Telegram Bot',
      configPath: '/fake/plist',
      autoRestartOnRebuild: false,
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'install', 'telegram', '--no-watch'], { from: 'user' });
    expect(mocks.install).toHaveBeenCalledWith('telegram', expect.objectContaining({ noWatch: true }));
  });
});

// ---------------------------------------------------------------------------
// service uninstall
// ---------------------------------------------------------------------------

describe('service uninstall', () => {
  it('prints success on uninstalled', async () => {
    mocks.uninstall.mockReturnValue({
      kind: 'uninstalled',
      configPath: '/fake/plist',
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'uninstall', 'telegram'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Uninstalled');
    expect(all).toContain('/fake/plist');
  });

  it('warns (no exit) on not-installed', async () => {
    mocks.uninstall.mockReturnValue({ kind: 'not-installed', configPath: '/fake/plist' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'uninstall', 'telegram'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('not installed');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on failed', async () => {
    mocks.uninstall.mockReturnValue({ kind: 'failed', reason: 'bootout failed' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'uninstall', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('bootout failed');
  });
});

// ---------------------------------------------------------------------------
// service status
// ---------------------------------------------------------------------------

describe('service status', () => {
  const runningStatus = {
    name: 'telegram' as const,
    label: 'AFK Telegram Bot',
    installed: true,
    configPath: '/fake/plist',
    pid: 1234,
    running: true,
    logFile: '/fake/logs/telegram.log',
  };
  const notInstalledStatus = {
    name: 'telegram' as const,
    label: 'AFK Telegram Bot',
    installed: false,
    configPath: '/fake/plist',
    logFile: '/fake/logs/telegram.log',
  };

  it('prints running status for a named service', async () => {
    mocks.status.mockReturnValue(runningStatus);
    const prog = makeProgram();
    await prog.parseAsync(['service', 'status', 'telegram'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Running');
    expect(all).toContain('1234');
  });

  it('prints not-installed status for a named service', async () => {
    mocks.status.mockReturnValue(notInstalledStatus);
    const prog = makeProgram();
    await prog.parseAsync(['service', 'status', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Not installed');
  });

  it('prints status for all services when no name given', async () => {
    mocks.status
      .mockReturnValueOnce({ ...runningStatus, name: 'telegram' })
      .mockReturnValueOnce({ ...runningStatus, name: 'daemon', label: 'AFK Daemon' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'status'], { from: 'user' });
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it('shows last exit status when non-zero', async () => {
    mocks.status.mockReturnValue({
      ...notInstalledStatus,
      installed: true,
      running: false,
      pid: undefined,
      lastExitStatus: 1,
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'status', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Last exit status: 1');
  });

  it('shows installed-but-not-running when installed=true but no pid and no running flag', async () => {
    mocks.status.mockReturnValue({
      name: 'telegram' as const,
      label: 'AFK Telegram Bot',
      installed: true,
      configPath: '/fake/plist',
      logFile: '/fake/logs/telegram.log',
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'status', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// service list
// ---------------------------------------------------------------------------

describe('service list', () => {
  it('lists all service names', async () => {
    mocks.isInstalled.mockReturnValue(false);
    mocks.configPath.mockReturnValue('/fake/plist');
    const prog = makeProgram();
    await prog.parseAsync(['service', 'list'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('telegram');
    expect(all).toContain('daemon');
  });

  it('marks installed services', async () => {
    mocks.isInstalled.mockImplementation((name: string) => name === 'telegram');
    mocks.configPath.mockReturnValue('/fake/plist');
    const prog = makeProgram();
    await prog.parseAsync(['service', 'list'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('installed');
  });
});

// ---------------------------------------------------------------------------
// service upgrade
// ---------------------------------------------------------------------------

describe('service upgrade', () => {
  it('prints success on upgraded', async () => {
    mocks.upgrade.mockReturnValue({
      kind: 'upgraded',
      label: 'AFK Telegram Bot',
      configPath: '/fake/plist',
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'upgrade', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Upgraded');
  });

  it('prints already-current message', async () => {
    mocks.upgrade.mockReturnValue({
      kind: 'already-current',
      label: 'AFK Telegram Bot',
      configPath: '/fake/plist',
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'upgrade', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('already up to date');
  });

  it('warns when not installed', async () => {
    mocks.upgrade.mockReturnValue({ kind: 'not-installed', configPath: '/fake/plist' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'upgrade', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('not installed');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on failed', async () => {
    mocks.upgrade.mockReturnValue({ kind: 'failed', reason: 'write error' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'upgrade', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('write error');
  });

  it('passes --no-watch to the manager', async () => {
    mocks.upgrade.mockReturnValue({ kind: 'already-current', label: 'x', configPath: '/p' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'upgrade', 'telegram', '--no-watch'], { from: 'user' });
    expect(mocks.upgrade).toHaveBeenCalledWith('telegram', expect.objectContaining({ noWatch: true }));
  });
});

// ---------------------------------------------------------------------------
// service restart
// ---------------------------------------------------------------------------

describe('service restart', () => {
  it('prints success on restarted', async () => {
    mocks.restart.mockReturnValue({ kind: 'restarted', label: 'AFK Telegram Bot' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'restart', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Restarted');
  });

  it('prints notes from restart result', async () => {
    mocks.restart.mockReturnValue({
      kind: 'restarted',
      label: 'AFK Telegram Bot',
      notes: ['config was updated'],
    });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'restart', 'telegram'], { from: 'user' });
    expect(logLines.join('\n')).toContain('config was updated');
  });

  it('exits 1 when not-installed', async () => {
    mocks.restart.mockReturnValue({ kind: 'not-installed', configPath: '/fake/plist' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'restart', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('not installed');
  });

  it('exits 1 on failed', async () => {
    mocks.restart.mockReturnValue({ kind: 'failed', reason: 'kickstart failed' });
    const prog = makeProgram();
    await prog.parseAsync(['service', 'restart', 'telegram'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('kickstart failed');
  });
});
