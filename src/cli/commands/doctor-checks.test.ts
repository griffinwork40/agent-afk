import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkImportAvailable, checkAnthropicKey, checkNpmBinOnPath } from './doctor-checks.js';
import type { DetectedSource } from '../../config/import-sources.js';

/** Minimal fixture for a present source with zero assets. */
function makeSource(
  overrides: Partial<DetectedSource> = {},
): DetectedSource {
  return {
    binary: 'claude-code',
    label: 'Claude Code',
    present: true,
    plugins: [],
    skills: [],
    mcpServers: [],
    mcpConfigPath: null,
    mcpFormat: 'json',
    ...overrides,
  };
}

vi.mock('../../agent/auth/credential-resolver.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent/auth/credential-resolver.js')>();
  return { ...orig, preloadClaudeKeychainOAuth: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn(() => '/usr/local\n') };
});

import { execSync as _execSync } from 'child_process';

describe('checkAnthropicKey', () => {
  it('calls preloadClaudeKeychainOAuth before checking the key', async () => {
    const { preloadClaudeKeychainOAuth } = await import(
      '../../agent/auth/credential-resolver.js'
    );
    await checkAnthropicKey();
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
  });
});

describe('checkImportAvailable', () => {
  it('returns null when detected list is empty', async () => {
    const result = await checkImportAvailable({ detected: [] });
    expect(result).toBeNull();
  });

  it('returns null when all sources are not present', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: false, plugins: [{ name: 'my-plugin', path: '/p' }] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when present source has no plugins or skills', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: true, plugins: [], skills: [] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when every present source with assets is already trusted', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    expect(result).toBeNull();
  });

  it('returns a warn Check when an untrusted present source has plugins', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
          skills: [],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Claude Code');
    expect(result?.fix).toContain('afk migrate');
  });

  it('returns a warn Check when an untrusted present source has skills', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          plugins: [],
          skills: [{ name: 'my-skill', path: '/s' }],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.fix).toContain('afk migrate');
  });

  it('reports only untrusted sources when mixed', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'p', path: '/p' }],
        }),
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          skills: [{ name: 's', path: '/s' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    // Only 'codex' is untrusted
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.detail).not.toContain('Claude Code');
  });
});

// ─── checkNpmBinOnPath — cross-platform regression tests (#2756) ──────────────
// Platform and PATH delimiter are injected so Windows behaviour is exercised
// on any host OS (no real win32 required).
describe('checkNpmBinOnPath', () => {
  // child_process is mocked at module scope via vi.mock above; _execSync is
  // the vi.fn() stub imported after the mock declaration.
  const mockedExecSync = vi.mocked(_execSync);

  beforeEach(() => {
    // Default: POSIX prefix; reset before each test
    mockedExecSync.mockReturnValue('/usr/local\n' as unknown as ReturnType<typeof import('child_process').execSync>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POSIX (linux/darwin)', () => {
    it('returns pass when <prefix>/bin is on PATH', async () => {
      vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
      const result = await checkNpmBinOnPath({ platform: 'linux', pathDelimiter: ':' });
      expect(result.state).toBe('pass');
      expect(result.detail).toBe('/usr/local/bin');
    });

    it('returns fail when <prefix>/bin is NOT on PATH', async () => {
      vi.stubEnv('PATH', '/usr/bin:/bin');
      const result = await checkNpmBinOnPath({ platform: 'linux', pathDelimiter: ':' });
      expect(result.state).toBe('fail');
      expect(result.detail).toBe('/usr/local/bin');
      expect(result.fix).toContain('/usr/local/bin');
    });

    it('strips trailing slash from prefix before appending /bin', async () => {
      mockedExecSync.mockReturnValue('/usr/local/\n' as unknown as ReturnType<typeof import('child_process').execSync>);
      vi.stubEnv('PATH', '/usr/local/bin:/usr/bin');
      const result = await checkNpmBinOnPath({ platform: 'linux', pathDelimiter: ':' });
      expect(result.state).toBe('pass');
      expect(result.detail).toBe('/usr/local/bin');
    });
  });

  describe('Windows (win32) — injected platform, no real win32 needed', () => {
    const WIN_PREFIX = 'C:\\Users\\Alice\\AppData\\Roaming\\npm';

    it('returns pass when the prefix itself is on PATH (no /bin suffix)', async () => {
      // npm prefix on Windows: C:\Users\Alice\AppData\Roaming\npm
      // npm places binaries directly there, not in a /bin subdirectory.
      mockedExecSync.mockReturnValue(`${WIN_PREFIX}\n` as unknown as ReturnType<typeof import('child_process').execSync>);
      vi.stubEnv('PATH', `C:\\Windows\\System32;${WIN_PREFIX}`);
      const result = await checkNpmBinOnPath({ platform: 'win32', pathDelimiter: ';' });
      expect(result.state).toBe('pass');
      expect(result.detail).toBe(WIN_PREFIX);
    });

    it('returns fail when prefix is NOT on PATH (old POSIX /bin bug would never match)', async () => {
      mockedExecSync.mockReturnValue(`${WIN_PREFIX}\n` as unknown as ReturnType<typeof import('child_process').execSync>);
      // PATH uses ';' delimiter; the npm dir is absent
      vi.stubEnv('PATH', 'C:\\Windows\\System32;C:\\Windows');
      const result = await checkNpmBinOnPath({ platform: 'win32', pathDelimiter: ';' });
      expect(result.state).toBe('fail');
      expect(result.detail).toBe(WIN_PREFIX);
    });

    it('strips trailing backslash from Windows prefix', async () => {
      mockedExecSync.mockReturnValue(`${WIN_PREFIX}\\\n` as unknown as ReturnType<typeof import('child_process').execSync>);
      vi.stubEnv('PATH', `C:\\Windows\\System32;${WIN_PREFIX}`);
      const result = await checkNpmBinOnPath({ platform: 'win32', pathDelimiter: ';' });
      expect(result.state).toBe('pass');
    });

    it('does NOT append /bin on win32 (regression guard for #2756)', async () => {
      mockedExecSync.mockReturnValue(`${WIN_PREFIX}\n` as unknown as ReturnType<typeof import('child_process').execSync>);
      // Only the raw prefix is on PATH — adding /bin would cause a false fail
      vi.stubEnv('PATH', WIN_PREFIX);
      const result = await checkNpmBinOnPath({ platform: 'win32', pathDelimiter: ';' });
      expect(result.state).toBe('pass');
      expect(result.detail).not.toContain('/bin');
    });
  });

  it('returns warn when execSync throws', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('npm not found'); });
    const result = await checkNpmBinOnPath();
    expect(result.state).toBe('warn');
    expect(result.detail).toMatch(/could not query/);
  });
});
