/**
 * Tests for the `registerBrowserCommand` CLI subcommands:
 *   afk browser connect
 *   afk browser disconnect
 *   afk browser profiles
 *   afk browser login  (error paths only — Playwright is never actually launched)
 *
 * Strategy:
 *   - All external I/O (fs, child_process, atomicWriteFile, getMcpConfigPath,
 *     getBrowserStateRoot, paths helpers, palette, handleCommandError) is mocked
 *     via vi.mock so tests run hermetically on any OS.
 *   - The `login` subcommand is an async commander action that imports Playwright
 *     dynamically; we stub the early-exit error paths (invalid URL, bad profile)
 *     without actually launching a browser.
 *   - Per the project POSIX guard (R4): no test is gated on process.platform.
 *
 * @module cli/commands/browser.command.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be created before any SUT import.
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockExistsSyncStore,
  mockReaddirSync,
  mockReadFileSync,
  mockStatSync,
  mockAtomicWriteFile,
  atomicWritten,
  mockGetMcpConfigPath,
  mockGetBrowserStateRoot,
  mockAssertSafeBrowserProfile,
  mockGetBrowserStorageStatePath,
  mockGetBrowserProfileStateDir,
  mockDecoratePlaywrightLaunchError,
  mockExecFileSync,
  consoleLog,
  consoleError,
  consoleWarn,
  mockProcessExit,
  mockGuardedEgressStart,
  mockGuardedEgressStop,
} = vi.hoisted(() => {
  const existsStore = new Set<string>();
  const written: Map<string, string> = new Map();

  const mockGetMcpConfigPath = vi.fn(() => '/fake/home/.afk/config/mcp.json');
  const mockGetBrowserStateRoot = vi.fn(() => '/fake/home/.afk/browser/profiles');
  const mockAssertSafeBrowserProfile = vi.fn((_p: string) => { /* noop — valid by default */ });
  const mockGetBrowserStorageStatePath = vi.fn((profile: string) =>
    `/fake/home/.afk/browser/profiles/${profile}/storageState.json`,
  );
  const mockGetBrowserProfileStateDir = vi.fn((profile: string) =>
    `/fake/home/.afk/browser/profiles/${profile}`,
  );
  const mockDecoratePlaywrightLaunchError = vi.fn((err: unknown) => err);

  return {
    mockExistsSync: vi.fn((p: string) => existsStore.has(p)),
    mockExistsSyncStore: existsStore,
    mockReaddirSync: vi.fn(() => []),
    mockReadFileSync: vi.fn(() => ''),
    mockStatSync: vi.fn(() => ({ mode: 0o644 })),
    mockAtomicWriteFile: vi.fn((_path: string, content: string) => {
      written.set(_path, content);
    }),
    atomicWritten: written,
    mockGetMcpConfigPath,
    mockGetBrowserStateRoot,
    mockAssertSafeBrowserProfile,
    mockGetBrowserStorageStatePath,
    mockGetBrowserProfileStateDir,
    mockDecoratePlaywrightLaunchError,
    mockExecFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    consoleLog: vi.fn(),
    consoleError: vi.fn(),
    consoleWarn: vi.fn(),
    mockProcessExit: vi.fn((_code?: number) => { throw new Error(`process.exit(${_code})`); }),
    mockGuardedEgressStart: vi.fn().mockResolvedValue({ headless: false }),
    mockGuardedEgressStop: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
    statSync: mockStatSync,
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../utils/atomic-write.js', () => ({
  atomicWriteFile: mockAtomicWriteFile,
}));

vi.mock('../../agent/mcp/index.js', () => ({
  getMcpConfigPath: mockGetMcpConfigPath,
}));

vi.mock('../../paths.js', () => ({
  getBrowserStateRoot: mockGetBrowserStateRoot,
  assertSafeBrowserProfile: mockAssertSafeBrowserProfile,
  getBrowserStorageStatePath: mockGetBrowserStorageStatePath,
  getBrowserProfileStateDir: mockGetBrowserProfileStateDir,
}));

vi.mock('../../browser/playwright-missing.js', () => ({
  decoratePlaywrightLaunchError: mockDecoratePlaywrightLaunchError,
}));

// GuardedEgress mock — delegates to hoisted fns so vi.mock factory can reference them.
vi.mock('../../browser/playwright/egress-launch.js', () => {
  class GuardedEgress {
    start(...args: unknown[]) { return mockGuardedEgressStart(...args); }
    stop(...args: unknown[]) { return mockGuardedEgressStop(...args); }
  }
  return { GuardedEgress };
});

vi.mock('../palette.js', () => ({
  palette: {
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    meta: (s: string) => s,
    info: (s: string) => s,
    heading: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown) => {
    throw err;
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// child_process mock — detectChromeMajorVersion uses execFileSync
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExecFileSync };
});

// connect-diagnosis mock — keeps `connect` hermetic: no `npm view` network
// call, no probe of the real Chrome profile folder, no open(1).
vi.mock('./browser.connect-diagnosis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser.connect-diagnosis.js')>();
  return {
    ...actual,
    resolveChromeDevtoolsMcpVersion: vi.fn(() => actual.CHROME_DEVTOOLS_MCP_FALLBACK_VERSION),
    printConnectDiagnosis: vi.fn(),
  };
});

// readline mock — waitForEnter uses createInterface
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: (_prompt: string, cb: () => void) => { cb(); },
    close: vi.fn(),
  })),
}));

// playwright mock — login action does a dynamic import('playwright')
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue(undefined),
        }),
        storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// SUT imported AFTER all mocks are in place.
import { registerBrowserCommand, CHROME_DEVTOOLS_SERVER_NAME, buildChromeDevtoolsEntry } from './browser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh Commander program with the browser subcommand registered. */
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit
  registerBrowserCommand(program);
  return program;
}

/** Seed a "virtual file" so existsSync(p) returns true. */
function seedFile(p: string, content?: string): void {
  mockExistsSyncStore.add(p);
  if (content !== undefined) {
    mockReadFileSync.mockReturnValue(content);
  }
}

const MCP_CONFIG_PATH = '/fake/home/.afk/config/mcp.json';

beforeEach(() => {
  // Clear hoisted console/exit mocks so calls from prior tests never leak.
  consoleLog.mockClear();
  consoleError.mockClear();
  consoleWarn.mockClear();
  mockProcessExit.mockClear();

  mockExistsSyncStore.clear();
  atomicWritten.clear();
  mockAtomicWriteFile.mockImplementation((_path: string, content: string) => {
    atomicWritten.set(_path, content);
    mockExistsSyncStore.add(_path);
  });
  mockReaddirSync.mockReturnValue([]);
  mockReadFileSync.mockReturnValue('');
  mockStatSync.mockReturnValue({ mode: 0o644 });
  mockGetMcpConfigPath.mockReturnValue(MCP_CONFIG_PATH);
  mockGetBrowserStateRoot.mockReturnValue('/fake/home/.afk/browser/profiles');
  mockAssertSafeBrowserProfile.mockImplementation((_p: string) => { /* noop */ });
  mockGetBrowserStorageStatePath.mockImplementation(
    (profile: string) => `/fake/home/.afk/browser/profiles/${profile}/storageState.json`,
  );
  mockGetBrowserProfileStateDir.mockImplementation(
    (profile: string) => `/fake/home/.afk/browser/profiles/${profile}`,
  );

  // Default: execFileSync always throws (Chrome not found).
  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

  // Redirect console + process.exit
  vi.spyOn(console, 'log').mockImplementation(consoleLog);
  vi.spyOn(console, 'error').mockImplementation(consoleError);
  vi.spyOn(console, 'warn').mockImplementation(consoleWarn);
  vi.spyOn(process, 'exit').mockImplementation(mockProcessExit as typeof process.exit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// browser connect
// ---------------------------------------------------------------------------

describe('browser connect', () => {
  it('adds the chrome-devtools entry when mcp.json does not exist', () => {
    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    expect(atomicWritten.has(MCP_CONFIG_PATH)).toBe(true);
    const written = JSON.parse(atomicWritten.get(MCP_CONFIG_PATH)!);
    expect(written.mcpServers[CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('stable'));
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Added/);
  });

  it('updates an existing entry with a different channel', () => {
    const existingCfg = JSON.stringify({
      mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: buildChromeDevtoolsEntry('stable') },
    });
    seedFile(MCP_CONFIG_PATH, existingCfg);
    mockReadFileSync.mockReturnValue(existingCfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect', '--channel', 'canary']);

    const written = JSON.parse(atomicWritten.get(MCP_CONFIG_PATH)!);
    expect(written.mcpServers[CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('canary'));
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Updated/);
  });

  it('reports already-configured when entry matches exactly', () => {
    const entry = buildChromeDevtoolsEntry('stable');
    const existingCfg = JSON.stringify({ mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: entry } });
    seedFile(MCP_CONFIG_PATH, existingCfg);
    mockReadFileSync.mockReturnValue(existingCfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    // Should NOT have written again (config matches).
    expect(atomicWritten.has(MCP_CONFIG_PATH)).toBe(false);
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/already configured/);
  });

  it('throws on an invalid --channel value', () => {
    const program = makeProgram();
    expect(() =>
      program.parse(['node', 'afk', 'browser', 'connect', '--channel', 'nightly']),
    ).toThrow(/--channel must be one of/);
  });

  it('preserves pre-existing mcpServers entries', () => {
    const existingCfg = JSON.stringify({ mcpServers: { other: { command: 'cat' } } });
    seedFile(MCP_CONFIG_PATH, existingCfg);
    mockReadFileSync.mockReturnValue(existingCfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    const written = JSON.parse(atomicWritten.get(MCP_CONFIG_PATH)!);
    expect(written.mcpServers['other']).toEqual({ command: 'cat' });
    expect(written.mcpServers[CHROME_DEVTOOLS_SERVER_NAME]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// browser disconnect
// ---------------------------------------------------------------------------

describe('browser disconnect', () => {
  it('warns and exits cleanly when mcp.json does not exist', () => {
    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'disconnect']);

    expect(atomicWritten.size).toBe(0);
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/No MCP config/);
  });

  it('warns when chrome-devtools entry is absent from an existing config', () => {
    const cfg = JSON.stringify({ mcpServers: { other: { command: 'cat' } } });
    seedFile(MCP_CONFIG_PATH, cfg);
    mockReadFileSync.mockReturnValue(cfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'disconnect']);

    expect(atomicWritten.size).toBe(0);
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/not configured/);
  });

  it('removes chrome-devtools entry and rewrites config', () => {
    const entry = buildChromeDevtoolsEntry('stable');
    const cfg = JSON.stringify({
      mcpServers: {
        [CHROME_DEVTOOLS_SERVER_NAME]: entry,
        other: { command: 'cat' },
      },
    });
    seedFile(MCP_CONFIG_PATH, cfg);
    mockReadFileSync.mockReturnValue(cfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'disconnect']);

    expect(atomicWritten.has(MCP_CONFIG_PATH)).toBe(true);
    const written = JSON.parse(atomicWritten.get(MCP_CONFIG_PATH)!);
    expect(written.mcpServers[CHROME_DEVTOOLS_SERVER_NAME]).toBeUndefined();
    expect(written.mcpServers['other']).toEqual({ command: 'cat' });

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Removed/);
  });
});

// ---------------------------------------------------------------------------
// browser profiles
// ---------------------------------------------------------------------------

describe('browser profiles', () => {
  it('prints a "no saved profiles" message when the root does not exist', () => {
    // getBrowserStateRoot returns a path that existsSync returns false for.
    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'profiles']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/No saved profiles/);
  });

  it('prints a "no saved profiles" message when root exists but has no subdirs', () => {
    const root = '/fake/home/.afk/browser/profiles';
    seedFile(root);
    mockReaddirSync.mockReturnValue([]);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'profiles']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/No saved profiles/);
  });

  it('lists profiles with ● when storageState.json is present', () => {
    const root = '/fake/home/.afk/browser/profiles';
    seedFile(root);
    // Must mirror the SUT's host-path join (browser.ts uses path.join), so the
    // mocked existsSync key matches on win32 where join emits backslashes.
    const stateFile = join(root, 'default', 'storageState.json');
    seedFile(stateFile);

    // readdirSync returns a Dirent-like object
    mockReaddirSync.mockReturnValue([
      { name: 'default', isDirectory: () => true },
    ] as unknown as ReturnType<typeof import('fs').readdirSync>);

    // existsSync needs to return true for both root AND storageState path
    mockExistsSync.mockImplementation((p: string) => mockExistsSyncStore.has(p));

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'profiles']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('default');
    // ● (filled) marker for a profile with storageState
    expect(logged).toMatch(/●/);
  });

  it('lists profiles with ○ when storageState.json is absent', () => {
    const root = '/fake/home/.afk/browser/profiles';
    seedFile(root);
    // The profile dir exists but NOT the storageState file
    mockReaddirSync.mockReturnValue([
      { name: 'work', isDirectory: () => true },
    ] as unknown as ReturnType<typeof import('fs').readdirSync>);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'profiles']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('work');
    expect(logged).toMatch(/no saved session/);
  });
});

// ---------------------------------------------------------------------------
// browser login — error paths (no real Playwright)
// ---------------------------------------------------------------------------

describe('browser login — validation errors', () => {
  it('throws on an invalid URL', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'afk', 'browser', 'login', 'not-a-url']),
    ).rejects.toThrow(/Invalid URL/);
  });

  it('throws on a non-http(s) URL', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'afk', 'browser', 'login', 'ftp://example.com']),
    ).rejects.toThrow(/must be http/);
  });

  it('throws when assertSafeBrowserProfile rejects the profile name', async () => {
    mockAssertSafeBrowserProfile.mockImplementationOnce(() => {
      throw new Error('unsafe profile name');
    });
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', '../evil']),
    ).rejects.toThrow(/unsafe profile name/);
  });

  it('reaches Playwright after validating a valid login URL and profile', async () => {
    // This covers validation flow only; the dedicated launch-failure test below
    // verifies decoratePlaywrightLaunchError and propagation.
    const program = makeProgram();
    // parseAsync will throw at the dynamic `import('playwright')` stage.
    // We catch that and confirm it is NOT one of our validation errors.
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'default']);
    } catch (err) {
      caught = err;
    }
    // The error must NOT be one of our URL-validation messages.
    if (caught instanceof Error) {
      expect(caught.message).not.toMatch(/Invalid URL|must be http|unsafe profile/);
    }
    // assertSafeBrowserProfile was called (profile validation ran).
    expect(mockAssertSafeBrowserProfile).toHaveBeenCalledWith('default');
  });
});

// ---------------------------------------------------------------------------
// readMcpConfigFile edge case via connect action
// ---------------------------------------------------------------------------

describe('browser connect — readMcpConfigFile error handling', () => {
  it('throws a clear error when mcp.json contains malformed JSON', () => {
    seedFile(MCP_CONFIG_PATH);
    mockReadFileSync.mockReturnValue('{ broken json');

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'connect'])).toThrow(/not valid JSON/);
  });

  it('throws when mcp.json top-level is not an object', () => {
    seedFile(MCP_CONFIG_PATH);
    mockReadFileSync.mockReturnValue('[]');

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'connect'])).toThrow(/must be a JSON object/);
  });

  it('throws when mcpServers is an array', () => {
    seedFile(MCP_CONFIG_PATH);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: [] }));

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'connect'])).toThrow(/not an array/);
  });

  it('throws "Failed to read MCP config" when readFileSync throws', () => {
    // File exists but reading it throws (e.g. permission denied).
    seedFile(MCP_CONFIG_PATH);
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'connect'])).toThrow(/Failed to read MCP config/);
  });
});

// ---------------------------------------------------------------------------
// printSetupGuidance Chrome version branches (exercised via connect)
// ---------------------------------------------------------------------------
// child_process is vi.mock'd above to always throw; we use vi.spyOn on the
// already-mocked module to control return values per-test.

describe('browser connect — printSetupGuidance Chrome version guidance', () => {
  beforeEach(() => {
    // Reset so we get a clean call list for each subtest.
    consoleLog.mockClear();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  });

  it('prints "Chrome not detected" guidance when execFileSync always throws', () => {
    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Chrome not detected/);
  });

  it('prints upgrade warning when Chrome < 144 is detected', () => {
    mockExecFileSync.mockReturnValueOnce('Google Chrome 130.0.6723.91 unknown\n');

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/130/);
    expect(logged).toMatch(/≥ 144/);
  });

  it('prints "detected ✓" confirmation when Chrome ≥ 144 is detected', () => {
    mockExecFileSync.mockReturnValueOnce('Google Chrome 144.0.7251.68 unknown\n');

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'connect']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Detected Chrome 144/);
  });
});

// ---------------------------------------------------------------------------
// browser login — success path (Playwright fully mocked)
// ---------------------------------------------------------------------------

describe('browser login — success path', () => {
  it('saves the session and prints the vault path', async () => {
    consoleLog.mockClear();
    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'default']);

    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Saved session for profile "default"/);
    expect(logged).toMatch(/Vault:/);
    // atomicWriteFile was called to persist the session.
    expect(mockAtomicWriteFile).toHaveBeenCalled();
  });

  it('restores an existing storageState when the profile file already exists', async () => {
    consoleLog.mockClear();
    const statePath = '/fake/home/.afk/browser/profiles/default/storageState.json';
    seedFile(statePath);

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'default']);

    // Should still succeed and write updated state.
    const logged = consoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Saved session for profile "default"/);
  });
});

// ---------------------------------------------------------------------------
// browser disconnect — error branch (handleCommandError)
// ---------------------------------------------------------------------------

describe('browser disconnect — error branch', () => {
  it('surfaces an error via handleCommandError when writeMcpConfigFileAtomic throws', () => {
    const entry = buildChromeDevtoolsEntry('stable');
    const cfg = JSON.stringify({ mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: entry } });
    seedFile(MCP_CONFIG_PATH);
    mockReadFileSync.mockReturnValue(cfg);
    mockAtomicWriteFile.mockImplementationOnce(() => { throw new Error('write failed'); });

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'disconnect'])).toThrow(/write failed/);
  });
});

// ---------------------------------------------------------------------------
// browser login — Playwright launch error path (decoratePlaywrightLaunchError)
// ---------------------------------------------------------------------------

describe('browser login — Playwright launch error', () => {
  it('calls decoratePlaywrightLaunchError and rethrows when chromium.launch rejects', async () => {
    const launchErr = new Error('Executable not found');
    const { chromium } = await import('playwright');
    vi.spyOn(chromium, 'launch').mockRejectedValueOnce(launchErr);
    mockDecoratePlaywrightLaunchError.mockReturnValueOnce(new Error('decorated: Executable not found'));

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com']),
    ).rejects.toThrow(/decorated: Executable not found/);
    expect(mockDecoratePlaywrightLaunchError).toHaveBeenCalledWith(launchErr, false);
  });
});

// ---------------------------------------------------------------------------
// browser login — GuardedEgress proxy wiring (#3720)
// ---------------------------------------------------------------------------

describe('browser login — GuardedEgress proxy wiring', () => {
  beforeEach(() => {
    mockGuardedEgressStart.mockClear();
    mockGuardedEgressStop.mockClear();
  });

  it('passes launch options from GuardedEgress.start() to chromium.launch', async () => {
    const proxyOptions = {
      headless: false,
      proxy: { server: 'http://127.0.0.1:9999', bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    };
    mockGuardedEgressStart.mockResolvedValueOnce(proxyOptions);

    const { chromium } = await import('playwright');
    const launchSpy = vi.spyOn(chromium, 'launch');

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'default']);

    expect(mockGuardedEgressStart).toHaveBeenCalledWith(false);
    expect(launchSpy).toHaveBeenCalledWith(proxyOptions);
  });

  it('calls GuardedEgress.stop() on the success path after the browser closes', async () => {
    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'default']);

    expect(mockGuardedEgressStop).toHaveBeenCalled();
  });

  it('calls GuardedEgress.stop() on the error path when chromium.launch rejects', async () => {
    const { chromium } = await import('playwright');
    vi.spyOn(chromium, 'launch').mockRejectedValueOnce(new Error('launch failed'));
    mockDecoratePlaywrightLaunchError.mockReturnValueOnce(new Error('launch failed'));

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com']),
    ).rejects.toThrow(/launch failed/);

    expect(mockGuardedEgressStop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// browser profiles — error branch (handleCommandError)
// ---------------------------------------------------------------------------

describe('browser profiles — error branch', () => {
  it('surfaces an error via handleCommandError when readdirSync throws', () => {
    const root = '/fake/home/.afk/browser/profiles';
    seedFile(root);
    mockReaddirSync.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });

    const program = makeProgram();
    expect(() => program.parse(['node', 'afk', 'browser', 'profiles'])).toThrow(/EACCES/);
  });
});

// ---------------------------------------------------------------------------
// writeMcpConfigFileAtomic — rewrite preserves existing file mode
// ---------------------------------------------------------------------------

describe('writeMcpConfigFileAtomic — preserves existing file mode on rewrite', () => {
  it('passes the existing mode to atomicWriteFile when the file already exists', () => {
    // File exists with restrictive mode; rewrite should preserve 0o600.
    seedFile(MCP_CONFIG_PATH);
    mockStatSync.mockReturnValue({ mode: 0o100600 }); // stat mode includes file-type bits

    // Trigger via disconnect (which rewrites an existing config).
    const entry = buildChromeDevtoolsEntry('stable');
    const cfg = JSON.stringify({ mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: entry } });
    mockReadFileSync.mockReturnValue(cfg);

    const program = makeProgram();
    program.parse(['node', 'afk', 'browser', 'disconnect']);

    // atomicWriteFile was called; the mode option must be 0o600 (0o100600 & 0o777).
    const calls = mockAtomicWriteFile.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect((lastCall[2] as { mode?: number }).mode).toBe(0o600);
  });
});
