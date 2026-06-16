import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { join } from 'path';

const FAKE_CACHE_DIR = '/tmp/afk-test-cache';

vi.mock('../paths.js', () => ({
  getAfkCacheDir: () => FAKE_CACHE_DIR,
}));

vi.mock('./version.js', () => ({
  getVersion: vi.fn(() => '1.10.1'),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// https mock — used by fetchLatestVersion tests
// vi.hoisted() is required so the variable is available inside the vi.mock()
// factory, which is hoisted to the top of the file by Vitest's transformer.
// ---------------------------------------------------------------------------

type FakeResponse = EventEmitter & { statusCode?: number; headers?: Record<string, string>; resume?: () => void };
type FakeRequest = EventEmitter & { setTimeout: (ms: number, cb: () => void) => FakeRequest; destroy: () => void };

const { mockHttpsGet } = vi.hoisted(() => ({
  mockHttpsGet: vi.fn<[string, { headers: Record<string, string> }, (res: FakeResponse) => void], FakeRequest>(),
}));

vi.mock('https', () => ({
  get: mockHttpsGet,
}));

// Helper: build a fake (req, res) pair and wire up the mock for a single call.
function buildFakeHttp(
  statusCode: number,
  body: string | null,
  headers: Record<string, string> = {},
): { req: FakeRequest; res: FakeResponse } {
  const res: FakeResponse = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.resume = vi.fn();

  const req: FakeRequest = Object.assign(new EventEmitter(), {
    setTimeout: vi.fn((_ms: number, _cb: () => void) => req),
    destroy: vi.fn(),
  });

  mockHttpsGet.mockImplementationOnce(
    (_url: string, _opts: unknown, cb: (r: FakeResponse) => void) => {
      // Schedule callback asynchronously so test setup can attach listeners first.
      Promise.resolve().then(() => {
        cb(res);
        if (body !== null) {
          res.emit('data', Buffer.from(body, 'utf-8'));
          res.emit('end');
        }
      });
      return req;
    },
  );

  return { req, res };
}

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { getVersion } from './version.js';
import {
  checkForUpdates,
  printUpdateBanner,
  triggerAutoUpdate,
  checkPendingUpdate,
  writePendingUpdateMarker,
  fetchLatestVersion,
} from './update-checker.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockSpawn = vi.mocked(spawn);
const mockGetVersion = vi.mocked(getVersion);
const pendingFile = join(FAKE_CACHE_DIR, 'pending-update.json');
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('update-checker', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockExistsSync.mockReturnValue(true);
    // clearAllMocks() does not reset implementations set via mockReturnValue,
    // so re-pin the default here to stop per-test prerelease overrides leaking.
    mockGetVersion.mockReturnValue('1.10.1');
    delete process.env['NO_UPDATE_NOTIFIER'];
    delete process.env['CI'];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('checkForUpdates', () => {
    it('returns null when policy is off', () => {
      expect(checkForUpdates('off')).toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('returns null when NO_UPDATE_NOTIFIER is set', () => {
      process.env['NO_UPDATE_NOTIFIER'] = '1';
      expect(checkForUpdates('notify')).toBeNull();
    });

    it('returns null when CI is set', () => {
      process.env['CI'] = 'true';
      expect(checkForUpdates('notify')).toBeNull();
    });

    it('spawns background check and returns null on cache miss', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(checkForUpdates('notify')).toBeNull();
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('returns UpdateInfo when cache has newer version', () => {
      const cache = JSON.stringify({ latestVersion: '1.11.0', checkedAt: Date.now() });
      mockReadFileSync.mockReturnValue(cache);

      const result = checkForUpdates('notify');
      expect(result).toEqual({
        currentVersion: '1.10.1',
        latestVersion: '1.11.0',
      });
    });

    it('returns null when cache version is same as current', () => {
      const cache = JSON.stringify({ latestVersion: '1.10.1', checkedAt: Date.now() });
      mockReadFileSync.mockReturnValue(cache);

      expect(checkForUpdates('notify')).toBeNull();
    });

    it('returns null when cache version is older', () => {
      const cache = JSON.stringify({ latestVersion: '1.9.0', checkedAt: Date.now() });
      mockReadFileSync.mockReturnValue(cache);

      expect(checkForUpdates('notify')).toBeNull();
    });

    it('spawns background check when cache is stale', () => {
      const staleCache = JSON.stringify({
        latestVersion: '1.11.0',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      mockReadFileSync.mockReturnValue(staleCache);

      checkForUpdates('notify');
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('does not spawn background check when cache is fresh', () => {
      const freshCache = JSON.stringify({ latestVersion: '1.11.0', checkedAt: Date.now() });
      mockReadFileSync.mockReturnValue(freshCache);

      checkForUpdates('notify');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    // --- prerelease ordering (exercises the private isNewerVersion) ---------
    // Before the fix, Number() on a "-beta"/"-rc" suffix produced NaN segments
    // whose comparisons are always false, so these two cases returned the wrong
    // boolean (a running prerelease never saw its release; a release wrongly
    // "updated" to a prerelease).

    it('treats the final release as newer than a running prerelease', () => {
      mockGetVersion.mockReturnValue('1.10.1-beta.1');
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ latestVersion: '1.10.1', checkedAt: Date.now() }),
      );

      expect(checkForUpdates('notify')).toEqual({
        currentVersion: '1.10.1-beta.1',
        latestVersion: '1.10.1',
      });
    });

    it('does not offer a prerelease as an update over the running release', () => {
      mockGetVersion.mockReturnValue('1.10.1');
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ latestVersion: '1.10.1-beta.5', checkedAt: Date.now() }),
      );

      expect(checkForUpdates('notify')).toBeNull();
    });

    it('compares numeric cores when a prerelease suffix is present', () => {
      mockGetVersion.mockReturnValue('1.10.1-rc.1');
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ latestVersion: '1.11.0', checkedAt: Date.now() }),
      );

      expect(checkForUpdates('notify')).toEqual({
        currentVersion: '1.10.1-rc.1',
        latestVersion: '1.11.0',
      });
    });
  });

  describe('printUpdateBanner', () => {
    it('writes version info to stderr', () => {
      printUpdateBanner({ currentVersion: '1.10.1', latestVersion: '1.11.0' });
      const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('1.10.1');
      expect(output).toContain('1.11.0');
      expect(output).toContain('npm install -g agent-afk');
    });
  });

  describe('triggerAutoUpdate', () => {
    it('spawns npm install and writes pending marker', () => {
      mockExistsSync.mockReturnValue(false); // no in-flight marker
      triggerAutoUpdate('1.11.0');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        pendingFile,
        expect.stringContaining('"targetVersion":"1.11.0"'),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', 'agent-afk@1.11.0'],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
    });

    it('rejects malicious version strings', () => {
      triggerAutoUpdate('1.0.0; rm -rf /');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('accepts pre-release versions', () => {
      mockExistsSync.mockReturnValue(false); // no in-flight marker
      triggerAutoUpdate('2.0.0-beta.1');
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('does not re-trigger when a pending marker already exists (install in flight)', () => {
      mockExistsSync.mockReturnValue(true); // marker on disk → install in flight
      triggerAutoUpdate('1.11.0');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('writePendingUpdateMarker', () => {
    it('writes the pending marker for a valid semver', () => {
      writePendingUpdateMarker('1.11.0');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        pendingFile,
        expect.stringContaining('"targetVersion":"1.11.0"'),
      );
    });

    it('rejects malicious version strings', () => {
      writePendingUpdateMarker('1.0.0; rm -rf /');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('silently swallows writeFileSync errors (best-effort)', () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      // Must not throw even when writeFileSync fails.
      expect(() => writePendingUpdateMarker('1.11.0')).not.toThrow();
    });
  });

  describe('checkPendingUpdate', () => {
    it('prints success and clears marker when version matches', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ targetVersion: '1.10.1', triggeredAt: Date.now() }),
      );

      checkPendingUpdate();

      expect(mockUnlinkSync).toHaveBeenCalledWith(pendingFile);
      const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Updated to agent-afk v1.10.1');
    });

    it('keeps a fresh non-matching marker (install still in flight)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ targetVersion: '1.11.0', triggeredAt: Date.now() }),
      );

      checkPendingUpdate();

      // The install hasn't landed yet; the marker must survive so that
      // triggerAutoUpdate() debounces and does not spawn a second install.
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).not.toContain('Updated');
    });

    it('clears a stale non-matching marker (install never completed)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          targetVersion: '1.11.0',
          triggeredAt: Date.now() - ONE_HOUR_MS - 60_000, // older than PENDING_TTL_MS
        }),
      );

      checkPendingUpdate();

      expect(mockUnlinkSync).toHaveBeenCalledWith(pendingFile);
      const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).not.toContain('Updated');
    });

    it('silently handles missing pending file', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => checkPendingUpdate()).not.toThrow();
    });
  });

  describe('fetchLatestVersion', () => {
    beforeEach(() => {
      mockHttpsGet.mockReset();
    });

    it('returns the version string on a successful 200 response', async () => {
      buildFakeHttp(200, JSON.stringify({ version: '1.12.0' }));
      const result = await fetchLatestVersion();
      expect(result).toBe('1.12.0');
    });

    it('returns undefined when the response is non-200', async () => {
      buildFakeHttp(404, null);
      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });

    it('returns undefined when the JSON body has no version field', async () => {
      buildFakeHttp(200, JSON.stringify({ name: 'agent-afk' }));
      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });

    it('returns undefined when the body is malformed JSON', async () => {
      buildFakeHttp(200, 'not-json{{{');
      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });

    it('returns undefined on a network error', async () => {
      const req: FakeRequest = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn((_ms: number, _cb: () => void) => req),
        destroy: vi.fn(),
      });
      mockHttpsGet.mockImplementationOnce(
        (_url: string, _opts: unknown, _cb: (r: FakeResponse) => void) => {
          Promise.resolve().then(() => { req.emit('error', new Error('ECONNREFUSED')); });
          return req;
        },
      );
      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });

    it('returns undefined on timeout and destroys the request', async () => {
      const req: FakeRequest = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn((ms: number, cb: () => void) => {
          // Fire the timeout callback synchronously to simulate expiry.
          void ms;
          Promise.resolve().then(cb);
          return req;
        }),
        destroy: vi.fn(),
      });
      mockHttpsGet.mockImplementationOnce(
        (_url: string, _opts: unknown, _cb: (r: FakeResponse) => void) => req,
      );
      const result = await fetchLatestVersion(1);
      expect(result).toBeUndefined();
      expect(req.destroy).toHaveBeenCalled();
    });

    it('follows a single 302 redirect and returns the version', async () => {
      const redirectTarget = 'https://redirected.example.com/agent-afk/latest';
      // First call: 302 redirect
      buildFakeHttp(302, null, { location: redirectTarget });
      // Second call: 200 success
      buildFakeHttp(200, JSON.stringify({ version: '1.12.0' }));

      const result = await fetchLatestVersion();
      expect(result).toBe('1.12.0');
    });

    it('returns undefined when response body exceeds 64 KB cap', async () => {
      const bigBody = 'x'.repeat(64 * 1024 + 1);
      const res: FakeResponse = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};

      const req: FakeRequest = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn((_ms: number, _cb: () => void) => req),
        destroy: vi.fn(),
      });

      mockHttpsGet.mockImplementationOnce(
        (_url: string, _opts: unknown, cb: (r: FakeResponse) => void) => {
          Promise.resolve().then(() => {
            cb(res);
            // Emit in two chunks: first sends enough to cross the cap.
            res.emit('data', Buffer.from(bigBody.slice(0, 32 * 1024), 'utf-8'));
            res.emit('data', Buffer.from(bigBody.slice(32 * 1024), 'utf-8'));
            res.emit('end');
          });
          return req;
        },
      );

      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });

    it('rejects a version field that does not match SEMVER_RE', async () => {
      buildFakeHttp(200, JSON.stringify({ version: 'not-a-semver' }));
      const result = await fetchLatestVersion();
      expect(result).toBeUndefined();
    });
  });
});
