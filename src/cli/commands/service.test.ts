/**
 * Tests for `afk service` CLI command group.
 *
 * Exercises subcommand registration, argument validation, platform dispatch,
 * error and refusal paths, and output formatting — all backed by a fully-mocked
 * ServiceManager so no real launchctl, systemctl, or Task Scheduler binary is
 * ever invoked, and no files are written to ~/Library/LaunchAgents,
 * ~/.config/systemd, or anywhere outside os.tmpdir().
 *
 * Pattern mirrors daemon.test.ts: vi.mock the modules that have side-effects,
 * drive the CLI through a Commander instance with program.exitOverride(), and
 * spy on console.log / console.error to assert output formatting.
 *
 * @module cli/commands/service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { ServiceManager, ServiceStatus, ServiceName } from '../../service/index.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import so vi.mock hoisting fires
// in the right order.
// ---------------------------------------------------------------------------

// Mock handleCommandError so unexpected throws surface as test failures
// rather than process.exit calls that abort the test runner.
vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

// Mock palette so all color-stripping / chalk side-effects are removed;
// the returned functions are identity so the content is still assertable.
vi.mock('../palette.js', () => ({
  palette: {
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    meta: (s: string) => s,
    info: (s: string) => s,
    heading: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// The factory is mocked so we can exercise the "unsupported platform" refusal
// path and control which mock manager is returned on supported platforms.
const { mockServiceManagerFor } = vi.hoisted(() => ({
  mockServiceManagerFor: vi.fn<(platform?: NodeJS.Platform) => ServiceManager | null>(),
}));

vi.mock('../../service/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/index.js')>();
  return {
    ...actual,
    serviceManagerFor: mockServiceManagerFor,
  };
});

// SUT imported AFTER mocks so the proxied modules are in place.
import { registerServiceCommand } from './service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub for a ServiceManager — all methods are vi.fn() by default. */
function makeManager(
  overrides: Partial<ServiceManager> = {},
): ServiceManager {
  return {
    backend: 'launchd',
    configKind: 'LaunchAgent plist',
    install: vi.fn(),
    uninstall: vi.fn(),
    status: vi.fn(),
    restart: vi.fn(),
    upgrade: vi.fn(),
    isInstalled: vi.fn(() => false),
    configPath: vi.fn((name: ServiceName) => `/mock/LaunchAgents/com.afk.${name}.plist`),
    logPath: vi.fn((name: ServiceName) => `/mock/.afk/logs/service-${name}.log`),
    label: vi.fn((name: ServiceName) => `com.afk.${name}`),
    readConfigFile: vi.fn(() => undefined),
    ...overrides,
  } as ServiceManager;
}

/** Minimal stub for a ServiceStatus snapshot. */
function makeStatus(name: ServiceName, overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name,
    label: `com.afk.${name}`,
    installed: false,
    configPath: `/mock/LaunchAgents/com.afk.${name}.plist`,
    logFile: `/mock/.afk/logs/service-${name}.log`,
    ...overrides,
  };
}

/** Build a fresh Commander program and register the service command into it. */
function buildProgram(): Command {
  const program = new Command();
  // exitOverride turns process.exit calls into thrown CommanderError so tests can catch them.
  program.exitOverride();
  registerServiceCommand(program);
  return program;
}

/** Run args through the program. Returns the program for further inspection. */
async function run(args: string[]): Promise<Command> {
  const program = buildProgram();
  await program.parseAsync(['node', 'afk', ...args]);
  return program;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logs: string[];
let errors: string[];
let processExitMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  // Spy on process.exit so we can assert it was called without actually exiting.
  processExitMock = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as (code?: number) => never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveManager — unsupported platform path
// ---------------------------------------------------------------------------

describe('afk service — unsupported platform', () => {
  it('install throws with a clear message when platform is unsupported', async () => {
    mockServiceManagerFor.mockReturnValue(null);
    await expect(run(['service', 'install', 'telegram'])).rejects.toThrow(
      /not supported/,
    );
  });

  it('list throws with a clear message when platform is unsupported', async () => {
    mockServiceManagerFor.mockReturnValue(null);
    await expect(run(['service', 'list'])).rejects.toThrow(/not supported/);
  });

  it('status throws with a clear message when platform is unsupported', async () => {
    mockServiceManagerFor.mockReturnValue(null);
    await expect(run(['service', 'status'])).rejects.toThrow(/not supported/);
  });
});

// ---------------------------------------------------------------------------
// parseServiceName — argument validation
// ---------------------------------------------------------------------------

describe('afk service install — argument validation', () => {
  it('throws for an unknown service name', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'install', 'bogus'])).rejects.toThrow(/Unknown service/);
  });

  it('throws for empty string (non-member)', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'install', ''])).rejects.toThrow(/Unknown service/);
  });

  it('accepts "telegram" (case-insensitive)', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'TELEGRAM']);
    expect(mgr.install).toHaveBeenCalledWith('telegram', expect.any(Object));
  });

  it('accepts "daemon"', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.daemon.plist',
        label: 'com.afk.daemon',
        autoRestartOnRebuild: false,
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'daemon']);
    expect(mgr.install).toHaveBeenCalledWith('daemon', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// afk service install
// ---------------------------------------------------------------------------

describe('afk service install', () => {
  it('prints success on kind=installed', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: true,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram']);
    expect(logs.some((l) => l.includes('Installed'))).toBe(true);
    expect(logs.some((l) => l.includes('Auto-restart on rebuild: on'))).toBe(true);
  });

  it('prints auto-restart off message when autoRestartOnRebuild is false', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.daemon.plist',
        label: 'com.afk.daemon',
        autoRestartOnRebuild: false,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-daemon.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'daemon']);
    expect(logs.some((l) => l.includes('Auto-restart on rebuild: off'))).toBe(true);
  });

  it('prints notes when present', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
        notes: ['loginctl enable-linger'],
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram']);
    expect(logs.some((l) => l.includes('loginctl enable-linger'))).toBe(true);
  });

  it('prints status hint when not a dry-run', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram']);
    expect(logs.some((l) => l.includes('afk service status telegram'))).toBe(true);
  });

  it('skips status hint on --dry-run', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram', '--dry-run']);
    expect(logs.some((l) => l.includes('afk service status'))).toBe(false);
  });

  it('exits 1 on kind=already-installed', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'already-installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'install', 'telegram'])).rejects.toThrow('process.exit called');
    expect(logs.some((l) => l.includes('already installed'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('exits 1 on kind=failed', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'failed' as const,
        reason: 'Permission denied',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'install', 'telegram'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('Permission denied'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('passes noWatch=true when --no-watch flag is set', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram', '--no-watch']);
    expect(mgr.install).toHaveBeenCalledWith('telegram', expect.objectContaining({ noWatch: true }));
  });

  it('passes dryRun=true when --dry-run flag is set', async () => {
    const mgr = makeManager({
      install: vi.fn(() => ({
        kind: 'installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
        autoRestartOnRebuild: false,
      })),
      logPath: vi.fn(() => '/mock/.afk/logs/service-telegram.log'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'install', 'telegram', '--dry-run']);
    expect(mgr.install).toHaveBeenCalledWith('telegram', expect.objectContaining({ dryRun: true }));
  });
});

// ---------------------------------------------------------------------------
// afk service uninstall
// ---------------------------------------------------------------------------

describe('afk service uninstall', () => {
  it('prints success on kind=uninstalled', async () => {
    const mgr = makeManager({
      uninstall: vi.fn(() => ({
        kind: 'uninstalled' as const,
        configPath: '/mock/com.afk.telegram.plist',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'uninstall', 'telegram']);
    expect(logs.some((l) => l.includes('Uninstalled'))).toBe(true);
  });

  it('prints a warning (no exit) on kind=not-installed', async () => {
    const mgr = makeManager({
      uninstall: vi.fn(() => ({
        kind: 'not-installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'uninstall', 'telegram']);
    expect(logs.some((l) => l.includes('not installed'))).toBe(true);
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('exits 1 on kind=failed', async () => {
    const mgr = makeManager({
      uninstall: vi.fn(() => ({
        kind: 'failed' as const,
        reason: 'OS rejected the unload',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'uninstall', 'telegram'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('OS rejected the unload'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('throws for an unknown service name', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'uninstall', 'bad-name'])).rejects.toThrow(/Unknown service/);
  });
});

// ---------------------------------------------------------------------------
// afk service status
// ---------------------------------------------------------------------------

describe('afk service status', () => {
  it('prints status for a single named service', async () => {
    const mgr = makeManager({
      status: vi.fn(() =>
        makeStatus('telegram', { installed: true, pid: 42, logFile: '/log/telegram.log' }),
      ),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status', 'telegram']);
    expect(mgr.status).toHaveBeenCalledWith('telegram');
    expect(logs.some((l) => l.includes('PID 42'))).toBe(true);
  });

  it('prints all services when no name is given', async () => {
    const mgr = makeManager({
      status: vi.fn((name: ServiceName) => makeStatus(name)),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status']);
    // Both telegram and daemon should have been queried.
    expect(mgr.status).toHaveBeenCalledWith('telegram');
    expect(mgr.status).toHaveBeenCalledWith('daemon');
  });

  it('shows not-installed output when service is not installed', async () => {
    const mgr = makeManager({
      status: vi.fn(() => makeStatus('telegram', { installed: false })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status', 'telegram']);
    expect(logs.some((l) => l.includes('Not installed'))).toBe(true);
  });

  it('shows installed-but-not-running when installed, no pid, running=false', async () => {
    const mgr = makeManager({
      status: vi.fn(() =>
        makeStatus('daemon', { installed: true, running: false }),
      ),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status', 'daemon']);
    expect(logs.some((l) => l.includes('Installed but not running'))).toBe(true);
  });

  it('shows last exit status when non-zero', async () => {
    const mgr = makeManager({
      status: vi.fn(() =>
        makeStatus('daemon', { installed: true, running: false, lastExitStatus: 127 }),
      ),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status', 'daemon']);
    expect(logs.some((l) => l.includes('127'))).toBe(true);
  });

  it('shows running when running=true (no pid)', async () => {
    const mgr = makeManager({
      status: vi.fn(() => makeStatus('telegram', { installed: true, running: true })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'status', 'telegram']);
    expect(logs.some((l) => l.includes('Running'))).toBe(true);
  });

  it('throws for an unknown service name', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'status', 'bad'])).rejects.toThrow(/Unknown service/);
  });
});

// ---------------------------------------------------------------------------
// afk service list
// ---------------------------------------------------------------------------

describe('afk service list', () => {
  it('lists all service names with installed markers', async () => {
    const mgr = makeManager({
      isInstalled: vi.fn((name: ServiceName) => name === 'telegram'),
      configPath: vi.fn((name: ServiceName) => `/mock/${name}.plist`),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'list']);
    // Both service names should appear in output.
    expect(logs.some((l) => l.includes('telegram'))).toBe(true);
    expect(logs.some((l) => l.includes('daemon'))).toBe(true);
    // The backend heading should appear.
    expect(logs.some((l) => l.includes('launchd'))).toBe(true);
  });

  it('marks not-installed services with ○', async () => {
    const mgr = makeManager({
      isInstalled: vi.fn(() => false),
      configPath: vi.fn(() => '/mock/path.plist'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'list']);
    expect(logs.some((l) => l.includes('not installed'))).toBe(true);
  });

  it('marks installed services with ●', async () => {
    const mgr = makeManager({
      isInstalled: vi.fn(() => true),
      configPath: vi.fn(() => '/mock/path.plist'),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'list']);
    expect(logs.some((l) => l.includes('installed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk service upgrade
// ---------------------------------------------------------------------------

describe('afk service upgrade', () => {
  it('prints success on kind=upgraded', async () => {
    const mgr = makeManager({
      upgrade: vi.fn(() => ({
        kind: 'upgraded' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'upgrade', 'telegram']);
    expect(logs.some((l) => l.includes('Upgraded'))).toBe(true);
  });

  it('prints already-current message on kind=already-current', async () => {
    const mgr = makeManager({
      upgrade: vi.fn(() => ({
        kind: 'already-current' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'upgrade', 'telegram']);
    expect(logs.some((l) => l.includes('already up to date'))).toBe(true);
  });

  it('prints not-installed message on kind=not-installed (no exit)', async () => {
    const mgr = makeManager({
      upgrade: vi.fn(() => ({
        kind: 'not-installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'upgrade', 'telegram']);
    expect(logs.some((l) => l.includes('not installed'))).toBe(true);
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('exits 1 on kind=failed', async () => {
    const mgr = makeManager({
      upgrade: vi.fn(() => ({
        kind: 'failed' as const,
        reason: 'write denied',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'upgrade', 'telegram'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('write denied'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('passes noWatch=true when --no-watch flag is set', async () => {
    const mgr = makeManager({
      upgrade: vi.fn(() => ({
        kind: 'already-current' as const,
        configPath: '/mock/com.afk.telegram.plist',
        label: 'com.afk.telegram',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'upgrade', 'telegram', '--no-watch']);
    expect(mgr.upgrade).toHaveBeenCalledWith('telegram', expect.objectContaining({ noWatch: true }));
  });

  it('throws for an unknown service name', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'upgrade', 'unknown'])).rejects.toThrow(/Unknown service/);
  });
});

// ---------------------------------------------------------------------------
// afk service restart
// ---------------------------------------------------------------------------

describe('afk service restart', () => {
  it('prints success on kind=restarted', async () => {
    const mgr = makeManager({
      restart: vi.fn(() => ({
        kind: 'restarted' as const,
        label: 'com.afk.telegram',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'restart', 'telegram']);
    expect(logs.some((l) => l.includes('Restarted'))).toBe(true);
  });

  it('prints notes when restart result has notes', async () => {
    const mgr = makeManager({
      restart: vi.fn(() => ({
        kind: 'restarted' as const,
        label: 'com.afk.telegram',
        notes: ['plist upgrade failed; used existing config'],
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await run(['service', 'restart', 'telegram']);
    expect(logs.some((l) => l.includes('plist upgrade failed'))).toBe(true);
  });

  it('exits 1 on kind=not-installed', async () => {
    const mgr = makeManager({
      restart: vi.fn(() => ({
        kind: 'not-installed' as const,
        configPath: '/mock/com.afk.telegram.plist',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'restart', 'telegram'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('not installed'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('exits 1 on kind=failed', async () => {
    const mgr = makeManager({
      restart: vi.fn(() => ({
        kind: 'failed' as const,
        reason: 'kickstart rejected',
      })),
    });
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'restart', 'telegram'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('kickstart rejected'))).toBe(true);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('throws for an unknown service name', async () => {
    const mgr = makeManager();
    mockServiceManagerFor.mockReturnValue(mgr);
    await expect(run(['service', 'restart', 'bad'])).rejects.toThrow(/Unknown service/);
  });
});

// ---------------------------------------------------------------------------
// Subcommand registration — ensure help text mentions known service names
// ---------------------------------------------------------------------------

describe('registerServiceCommand — subcommand registration', () => {
  it('registers a "service" subcommand on the program', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('service');
  });

  it('registers all expected sub-subcommands', () => {
    const program = buildProgram();
    const service = program.commands.find((c) => c.name() === 'service')!;
    const subs = service.commands.map((c) => c.name());
    expect(subs).toContain('install');
    expect(subs).toContain('uninstall');
    expect(subs).toContain('status');
    expect(subs).toContain('list');
    expect(subs).toContain('upgrade');
    expect(subs).toContain('restart');
  });
});
