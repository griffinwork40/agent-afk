/**
 * Tests for `afk browser` command group — command-level coverage (COV-010 / #2940).
 *
 * Covers: connect (add/update/already-configured/bad-channel/chrome-version branches),
 *         disconnect (no-config/not-configured/removes-entry),
 *         profiles (empty-root/no-root/with-state/without-state),
 *         login URL-validation + profile-validation (Playwright never imported).
 *
 * All tests are hermetic: no real browser is launched, no real mcp.json is
 * touched. Playwright is never imported (it may not be installed in CI).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Module mocks — must be at the top level before any imports of the module
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('chrome not found');
  }),
}));

vi.mock('../../agent/mcp/config-loader.js', () => ({
  getMcpConfigPath: vi.fn(() => '/mock/mcp.json'),
}));

vi.mock('../palette.js', () => ({
  palette: {
    success: (s: string) => s,
    warning: (s: string) => s,
    meta: (s: string) => s,
    heading: (s: string) => s,
  },
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err;
  }),
}));

vi.mock('../../browser/playwright-missing.js', () => ({
  decoratePlaywrightLaunchError: vi.fn((err: unknown) => err),
}));

// Mock paths so no real AFK_HOME is needed
vi.mock('../../paths.js', () => ({
  assertSafeBrowserProfile: vi.fn((profile: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(profile) || profile.length === 0) {
      throw new Error(`Invalid browser profile: ${JSON.stringify(profile)}`);
    }
  }),
  getBrowserStateRoot: vi.fn(() => '/mock/state/browser'),
  getBrowserProfileStateDir: vi.fn((profile: string) => `/mock/state/browser/${profile}`),
  getBrowserStorageStatePath: vi.fn((profile: string) =>
    `/mock/state/browser/${profile}/storageState.json`,
  ),
}));

// We let atomicWriteFile write for real so disconnect/profiles tests see actual disk state.
// The mock simply forwards to the real implementation.
vi.mock('../../utils/atomic-write.js', async (importOriginal) => {
  return importOriginal();
});



// Mock readline so waitForEnter resolves immediately (no stdin interaction)
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: () => void) => cb()),
    close: vi.fn(),
  })),
}));

// Mock playwright so the login action body (lines 288-313) can be exercised
// without a real browser. The mock returns a minimal stub that satisfies every
// await call the command makes.
vi.mock('playwright', async () => {
  const storageState = { cookies: [], origins: [] };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue(storageState),
  };
  const browserInstance = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(browserInstance),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';
import { getMcpConfigPath } from '../../agent/mcp/config-loader.js';
import { getBrowserStateRoot, assertSafeBrowserProfile } from '../../paths.js';
import {
  buildChromeDevtoolsEntry,
  readMcpConfigFile,
  CHROME_DEVTOOLS_SERVER_NAME,
  registerBrowserCommand,
} from './browser.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockGetMcpConfigPath = vi.mocked(getMcpConfigPath);
const mockGetBrowserStateRoot = vi.mocked(getBrowserStateRoot);
const mockAssertSafeBrowserProfile = vi.mocked(assertSafeBrowserProfile);

// Silence unused-var lint for mockAtomicWriteFile (removed — we use the real impl)
void mockExecFileSync;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// connect subcommand
// ---------------------------------------------------------------------------

describe('afk browser connect', () => {
  let dir: string;
  let cfgPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-browser-connect-'));
    cfgPath = join(dir, 'mcp.json');
    mockGetMcpConfigPath.mockReturnValue(cfgPath);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Default: Chrome not found on this machine
    mockExecFileSync.mockImplementation(() => {
      throw new Error('chrome not found');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the chrome-devtools entry to a fresh (absent) config', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    const cfg = readMcpConfigFile(cfgPath);
    expect(cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('stable'));
  });

  it('prints "Added" on first connect', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Added'));
  });

  it('prints "Updated" when replacing a different existing entry', async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: { command: 'old' } } }),
    );
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('prints "already configured" when entry is identical', async () => {
    const cfg = {
      mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: buildChromeDevtoolsEntry('stable') },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already configured'));
  });

  it('wires the canary channel via --channel', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect', '--channel', 'canary']);
    const cfg = readMcpConfigFile(cfgPath);
    expect(cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('canary'));
  });

  it('wires the beta channel via --channel', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect', '--channel', 'beta']);
    const cfg = readMcpConfigFile(cfgPath);
    expect(cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('beta'));
  });

  it('wires the dev channel via --channel', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect', '--channel', 'dev']);
    const cfg = readMcpConfigFile(cfgPath);
    expect(cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry('dev'));
  });

  it('throws on an invalid channel value', async () => {
    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'connect', '--channel', 'nightly']),
    ).rejects.toThrow(/--channel must be one of/);
  });

  it('prints Chrome-not-detected note when execFileSync always throws', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Chrome not detected'));
  });

  it('prints version-ok note when Chrome >= 144 is detected', async () => {
    mockExecFileSync.mockReturnValueOnce('Google Chrome 150.0.0.0\n' as unknown as Buffer);
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('150'));
  });

  it('prints upgrade warning when Chrome < 144 is detected', async () => {
    mockExecFileSync.mockReturnValueOnce('Google Chrome 120.0.0.0\n' as unknown as Buffer);
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Please update Chrome'));
  });

  it('preserves existing unrelated MCP servers when adding chrome-devtools', async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: 'cat' } } }));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'connect']);
    const cfg = readMcpConfigFile(cfgPath);
    expect(cfg.mcpServers!['other']).toEqual({ command: 'cat' });
    expect(cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// disconnect subcommand
// ---------------------------------------------------------------------------

describe('afk browser disconnect', () => {
  let dir: string;
  let cfgPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-browser-disconnect-'));
    cfgPath = join(dir, 'mcp.json');
    mockGetMcpConfigPath.mockReturnValue(cfgPath);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when no mcp.json exists at the config path', async () => {
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No MCP config'));
  });

  it('warns when chrome-devtools is not in the config', async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: 'cat' } } }));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('removes the chrome-devtools entry and leaves other servers intact', async () => {
    const cfg = {
      mcpServers: {
        [CHROME_DEVTOOLS_SERVER_NAME]: buildChromeDevtoolsEntry(),
        other: { command: 'cat' },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);

    const result = readMcpConfigFile(cfgPath);
    expect(result.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toBeUndefined();
    expect(result.mcpServers!['other']).toEqual({ command: 'cat' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('removes chrome-devtools when it is the only server entry', async () => {
    const cfg = { mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: buildChromeDevtoolsEntry() } };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);

    const result = readMcpConfigFile(cfgPath);
    expect(result.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toBeUndefined();
  });

  it('handles a config where mcpServers is absent (warns not-configured)', async () => {
    writeFileSync(cfgPath, JSON.stringify({ someOtherKey: true }));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('handles a config where mcpServers is null (warns not-configured, covers line 117)', async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: null }));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('propagates unexpected errors via handleCommandError (disconnect catch branch)', async () => {
    // Make getMcpConfigPath return a path that exists but readFileSync will throw
    // by pointing at a directory (not a file) — readdirSync vs readFileSync path.
    const badPath = dir; // dir is a directory, not a file
    // Write a marker file so existsSync(badPath) is true — use the dir itself.
    mockGetMcpConfigPath.mockReturnValue(dir);
    // readMcpConfigFile will try readFileSync on a directory → EISDIR
    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'disconnect']),
    ).rejects.toThrow();
    void badPath; // suppress lint
  });
});

// ---------------------------------------------------------------------------
// profiles subcommand
// ---------------------------------------------------------------------------

describe('afk browser profiles', () => {
  let dir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-browser-profiles-'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints "No saved profiles" when root directory does not exist', async () => {
    mockGetBrowserStateRoot.mockReturnValue(join(dir, 'nonexistent'));
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No saved profiles'));
  });

  it('prints "No saved profiles" when root exists but contains no subdirectories', async () => {
    const root = join(dir, 'browser');
    mkdirSync(root, { recursive: true });
    mockGetBrowserStateRoot.mockReturnValue(root);
    await buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No saved profiles'));
  });

  it('lists a profile that has a storageState.json (filled marker)', async () => {
    const root = join(dir, 'browser');
    const profileDir = join(root, 'myprofile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'storageState.json'), '{}');
    mockGetBrowserStateRoot.mockReturnValue(root);

    await buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('myprofile'))).toBe(true);
    // Should NOT print "no saved session" for a profile that has state
    expect(calls.some((s) => s.includes('myprofile') && s.includes('no saved session'))).toBe(false);
  });

  it('lists a profile directory without storageState.json with empty-marker note', async () => {
    const root = join(dir, 'browser');
    mkdirSync(join(root, 'emptyprofile'), { recursive: true });
    mockGetBrowserStateRoot.mockReturnValue(root);

    await buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('emptyprofile'))).toBe(true);
    expect(calls.some((s) => s.includes('no saved session'))).toBe(true);
  });

  it('propagates unexpected errors via handleCommandError (profiles catch branch)', async () => {
    mockGetBrowserStateRoot.mockImplementation(() => {
      throw new Error('disk exploded');
    });
    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']),
    ).rejects.toThrow('disk exploded');
  });

  it('prints the export usage hint after listing profiles', async () => {
    const root = join(dir, 'browser');
    mkdirSync(join(root, 'p1'), { recursive: true });
    writeFileSync(join(root, 'p1', 'storageState.json'), '{}');
    mockGetBrowserStateRoot.mockReturnValue(root);

    await buildProgram().parseAsync(['node', 'afk', 'browser', 'profiles']);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('AFK_BROWSER_DEFAULT_PROFILE'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readMcpConfigFile — error branch (line 98: readFileSync throws)
// ---------------------------------------------------------------------------

describe('readMcpConfigFile — readFileSync error branch', () => {
  it('throws a clear error when readFileSync fails (e.g. permission denied)', async () => {
    // Create a real file, then make it unreadable (POSIX only; on non-POSIX the
    // chmod is a no-op and the test degrades gracefully via try/catch below).
    const dir = mkdtempSync(join(tmpdir(), 'afk-mcp-perms-'));
    const path = join(dir, 'mcp.json');
    try {
      writeFileSync(path, '{}');
      // Make unreadable; if chmod is not supported (e.g. running as root) skip.
      const { chmodSync } = await import('fs');
      chmodSync(path, 0o000);
      // Only assert if we're not root (root ignores permissions).
      if (process.getuid && process.getuid() !== 0) {
        expect(() => readMcpConfigFile(path)).toThrow(/Failed to read MCP config/);
      }
    } finally {
      const { chmodSync } = await import('fs');
      try { chmodSync(path, 0o644); } catch { /* best-effort */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// login subcommand — URL-validation and profile-validation (no browser)
// ---------------------------------------------------------------------------

describe('afk browser login — validation gates', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Default: profile validation passes
    mockAssertSafeBrowserProfile.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws on a completely invalid URL string', async () => {
    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'login', 'not-a-url']),
    ).rejects.toThrow(/Invalid URL/);
  });

  it('throws when the URL protocol is ftp (not http/https)', async () => {
    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'login', 'ftp://example.com']),
    ).rejects.toThrow(/must be http\(s\)/);
  });

  it('throws when assertSafeBrowserProfile rejects the profile name', async () => {
    mockAssertSafeBrowserProfile.mockImplementation(() => {
      throw new Error('Invalid browser profile: "bad/name"');
    });
    await expect(
      buildProgram().parseAsync([
        'node',
        'afk',
        'browser',
        'login',
        'https://example.com',
        '--profile',
        'bad/name',
      ]),
    ).rejects.toThrow(/Invalid browser profile/);
  });

  it('passes URL validation for https:// and reaches Playwright import (which fails in CI)', async () => {
    // After URL + profile validation, the command does `await import('playwright')`.
    // In test environments Playwright may not be installed. The error must NOT be
    // our URL-validation error — proving the validation branch was passed.
    const err = await buildProgram()
      .parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com'])
      .catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/Invalid URL/);
    expect(String(err)).not.toMatch(/must be http/);
  });

  it('passes URL validation for http:// (localhost dev server case)', async () => {
    const err = await buildProgram()
      .parseAsync(['node', 'afk', 'browser', 'login', 'http://localhost:3000'])
      .catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/Invalid URL/);
    expect(String(err)).not.toMatch(/must be http/);
  });
});

// ---------------------------------------------------------------------------
// login subcommand — full success path (Playwright mocked, waitForEnter mocked)
// ---------------------------------------------------------------------------

import { getBrowserProfileStateDir, getBrowserStorageStatePath } from '../../paths.js';
const mockGetBrowserProfileStateDir = vi.mocked(getBrowserProfileStateDir);
const mockGetBrowserStorageStatePath = vi.mocked(getBrowserStorageStatePath);

describe('afk browser login — success path (Playwright mocked)', () => {
  let dir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-browser-login-'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockAssertSafeBrowserProfile.mockImplementation(() => undefined);
    // Point state paths into a real temp dir so atomicWriteFile can write
    mockGetBrowserProfileStateDir.mockImplementation((profile: string) =>
      join(dir, profile),
    );
    mockGetBrowserStorageStatePath.mockImplementation((profile: string) =>
      join(dir, profile, 'storageState.json'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('completes a full login flow with the default profile', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'browser', 'login', 'https://example.com',
    ]);
    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('Saved session'))).toBe(true);
    // storageState.json should have been written to the real temp dir
    const { existsSync } = await import('fs');
    expect(existsSync(join(dir, 'default', 'storageState.json'))).toBe(true);
  });

  it('uses the --profile name in the success message', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'browser', 'login', 'https://example.com', '--profile', 'work',
    ]);
    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('"work"'))).toBe(true);
  });

  it('prints the AFK_BROWSER_DEFAULT_PROFILE export hint', async () => {
    await buildProgram().parseAsync([
      'node', 'afk', 'browser', 'login', 'https://example.com',
    ]);
    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('AFK_BROWSER_DEFAULT_PROFILE'))).toBe(true);
  });

  it('covers page.goto non-fatal catch (line 292) — goto rejects but login succeeds', async () => {
    // Make page.goto reject — the command swallows it (non-fatal)
    const { chromium } = await import('playwright');
    const browserInstance = await (chromium.launch as ReturnType<typeof vi.fn>)();
    const context = await browserInstance.newContext();
    const page = await context.newPage();
    vi.mocked(page.goto).mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await buildProgram().parseAsync([
      'node', 'afk', 'browser', 'login', 'https://example.com',
    ]);
    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    // Login still completes despite goto failure
    expect(calls.some((s) => s.includes('Saved session'))).toBe(true);
  });

  it('covers browserInstance.close non-fatal catch (line 308) — close rejects but login succeeds', async () => {
    const { chromium } = await import('playwright');
    const browserInstance = await (chromium.launch as ReturnType<typeof vi.fn>)();
    vi.mocked(browserInstance.close).mockRejectedValueOnce(new Error('already closed'));

    await buildProgram().parseAsync([
      'node', 'afk', 'browser', 'login', 'https://example.com',
    ]);
    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('Saved session'))).toBe(true);
  });

  it('covers chromium.launch catch (line 283) — propagates decorated error', async () => {
    const { chromium } = await import('playwright');
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error('playwright not installed'));

    await expect(
      buildProgram().parseAsync(['node', 'afk', 'browser', 'login', 'https://example.com']),
    ).rejects.toThrow(/playwright not installed/);
  });
});
