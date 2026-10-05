/**
 * Unit tests for daemonDefaultCwd() in session-spawn.ts.
 *
 * Covers memoization and the EACCES / ENOSPC fallback paths (#2638).
 *
 * Strategy: vi.mock('node:fs', ...) replaces mkdirSync with a dispatch shim
 * that reads from `mockState`. When `mockState.mkdirOverride` is null the
 * real mkdirSync is called; when it is set, the override fires.
 *
 * vi.hoisted() makes `mockState` available inside the factory, which runs
 * before any regular import. The real mkdirSync is captured inside the factory
 * (where the `original` module is available before the mock replaces it).
 *
 * All other fs operations (mkdtempSync, rmSync, statSync) are kept as
 * pass-throughs from `...original` and used via the mocked `node:fs` namespace,
 * which is fine because they are not overridden.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

// ── hoisted state (available inside vi.mock factory) ──────────────────────────
const mockState = vi.hoisted(() => ({
  /** Override mkdirSync in session-spawn.ts. null = use real implementation. */
  mkdirOverride: null as ((path: string | Buffer | URL, opts?: unknown) => void) | null,
  /** The real mkdirSync, captured in the mock factory before replacement. */
  realMkdirSync: null as typeof import('node:fs').mkdirSync | null,
}));

// ── module-level fs mock ──────────────────────────────────────────────────────
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  // Capture the real implementation before the mock replaces it.
  mockState.realMkdirSync = real.mkdirSync;
  return {
    ...real,
    mkdirSync: (...args: Parameters<typeof real.mkdirSync>) => {
      if (mockState.mkdirOverride !== null) {
        return mockState.mkdirOverride(args[0] as string, args[1]);
      }
      return real.mkdirSync(...args);
    },
  };
});

// Import after mock is registered.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { daemonDefaultCwd, _resetDaemonDefaultCwdCache } from './session-spawn.js';
import { getDaemonStateDir } from '../../paths.js';

// ── helpers ───────────────────────────────────────────────────────────────────
function makeTmpDir(): string {
  return mkdtempSync(join(osTmpdir(), 'session-spawn-test-'));
}

function makeFsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// ── global lifecycle ──────────────────────────────────────────────────────────
let isolatedAfkHome: string | undefined;
let savedAfkHome: string | undefined;

beforeEach(() => {
  isolatedAfkHome = makeTmpDir();
  savedAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = isolatedAfkHome;
  // Reset the memoization cache so every test starts fresh.
  _resetDaemonDefaultCwdCache();
  // Default: no override — pass through to real mkdirSync.
  mockState.mkdirOverride = null;
});

afterEach(() => {
  if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedAfkHome;
  if (isolatedAfkHome !== undefined) rmSync(isolatedAfkHome, { recursive: true, force: true });
  isolatedAfkHome = undefined;
  _resetDaemonDefaultCwdCache();
  mockState.mkdirOverride = null;
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('daemonDefaultCwd', () => {
  it('returns the daemon state directory and creates it when absent', () => {
    const expected = getDaemonStateDir();
    const result = daemonDefaultCwd();
    expect(result).toBe(expected);
    // Directory must exist on disk after the call.
    expect(statSync(result).isDirectory()).toBe(true);
  });

  it('memoizes after first success — mkdirSync is called only once for the daemon dir (#2638)', () => {
    // Count only the mkdirSync calls for the exact daemon state dir so other
    // module-level mkdirSync calls (MemoryStore, etc.) are not included.
    const daemonDir = getDaemonStateDir();
    let daemonDirCallCount = 0;
    mockState.mkdirOverride = (path, opts) => {
      if (path === daemonDir) daemonDirCallCount++;
      mockState.realMkdirSync!(path as string, opts as Parameters<typeof import('node:fs').mkdirSync>[1]);
    };

    const first = daemonDefaultCwd();
    const second = daemonDefaultCwd();
    const third = daemonDefaultCwd();

    expect(first).toBe(daemonDir);
    expect(second).toBe(daemonDir);
    expect(third).toBe(daemonDir);
    // mkdirSync for the daemon dir must have been called exactly once — the
    // second and third calls return the memoized value without touching the FS.
    expect(daemonDirCallCount).toBe(1);
  });

  it('_resetDaemonDefaultCwdCache() clears the memo so a fresh mkdir fires on next call', () => {
    const daemonDir = getDaemonStateDir();
    let daemonDirCallCount = 0;
    mockState.mkdirOverride = (path, opts) => {
      if (path === daemonDir) daemonDirCallCount++;
      mockState.realMkdirSync!(path as string, opts as Parameters<typeof import('node:fs').mkdirSync>[1]);
    };

    daemonDefaultCwd(); // populates cache → daemonDirCallCount becomes 1
    _resetDaemonDefaultCwdCache(); // wipes the memo
    daemonDefaultCwd(); // cache is empty again → daemonDirCallCount becomes 2

    expect(daemonDirCallCount).toBe(2);
  });

  it('falls back to os.tmpdir() on EACCES without throwing (#2638)', () => {
    mockState.mkdirOverride = () => {
      throw makeFsError('EACCES');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = daemonDefaultCwd();

    // Must never throw; os.tmpdir() is the safe fallback.
    expect(result).toBe(osTmpdir());
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('EACCES warning includes the error code, fallback path, and AFK_STATE_DIR remediation hint (#2638)', () => {
    mockState.mkdirOverride = () => {
      throw makeFsError('EACCES');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    daemonDefaultCwd();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    // Error code present in the warning.
    expect(msg).toMatch(/EACCES/);
    // Fallback destination present.
    expect(msg).toContain(osTmpdir());
    // Remediation hint present: users need actionable guidance (#2638).
    expect(msg).toMatch(/AFK_STATE_DIR/);
  });

  it('falls back to os.tmpdir() on ENOSPC without throwing', () => {
    mockState.mkdirOverride = () => {
      throw makeFsError('ENOSPC');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = daemonDefaultCwd();

    expect(result).toBe(osTmpdir());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toMatch(/ENOSPC/);
  });
});
