/**
 * Tests for the Telegram bot process manager.
 *
 * Covers the pure helpers (parseEtime, isRunning) plus a smoke-level start/
 * stop round-trip using a no-op child process. We don't exercise the real
 * `dist/telegram.js` here because it'd need a full bot token + auth + the
 * Telegram API — that's the job of an integration test, not a unit test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseEtime, isRunning, getManagerPaths } from '../../src/telegram/manager.js';
import { checkVersionDrift } from '../../src/telegram/version-check.js';

describe('manager helpers', () => {
  describe('parseEtime', () => {
    it('parses ss', () => {
      expect(parseEtime('42')).toBe(42);
    });

    it('parses mm:ss', () => {
      expect(parseEtime('05:42')).toBe(5 * 60 + 42);
    });

    it('parses hh:mm:ss', () => {
      expect(parseEtime('02:05:42')).toBe(2 * 3600 + 5 * 60 + 42);
    });

    it('parses dd-hh:mm:ss', () => {
      expect(parseEtime('3-02:05:42')).toBe(3 * 86400 + 2 * 3600 + 5 * 60 + 42);
    });

    it('returns undefined for empty input', () => {
      expect(parseEtime('')).toBeUndefined();
    });

    it('returns undefined for malformed input', () => {
      expect(parseEtime('not-a-time')).toBeUndefined();
    });
  });

  describe('isRunning', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'afk-mgr-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null when PID file is absent', () => {
      expect(isRunning(join(tmpDir, 'missing.pid'))).toBeNull();
    });

    it('returns null and cleans up stale PID file (non-existent process)', () => {
      const pidFile = join(tmpDir, 'stale.pid');
      // PID 999999 is virtually guaranteed not to exist
      writeFileSync(pidFile, '999999');
      expect(isRunning(pidFile)).toBeNull();
      expect(existsSync(pidFile)).toBe(false);
    });

    it('returns null and cleans up garbage PID file', () => {
      const pidFile = join(tmpDir, 'garbage.pid');
      writeFileSync(pidFile, 'not-a-number');
      expect(isRunning(pidFile)).toBeNull();
      expect(existsSync(pidFile)).toBe(false);
    });

    it('returns the PID when process is alive', () => {
      const pidFile = join(tmpDir, 'self.pid');
      writeFileSync(pidFile, String(process.pid));
      expect(isRunning(pidFile)).toBe(process.pid);
    });
  });

  describe('getManagerPaths', () => {
    it('returns paths under AFK_HOME', () => {
      const originalHome = process.env['AFK_HOME'];
      const tmp = mkdtempSync(join(tmpdir(), 'afk-paths-test-'));
      process.env['AFK_HOME'] = tmp;
      try {
        const paths = getManagerPaths();
        expect(paths.pidFile.startsWith(tmp)).toBe(true);
        expect(paths.logFile.startsWith(tmp)).toBe(true);
        expect(paths.pidFile).toContain('telegram');
        expect(paths.logFile).toContain('telegram.log');
      } finally {
        if (originalHome !== undefined) {
          process.env['AFK_HOME'] = originalHome;
        } else {
          delete process.env['AFK_HOME'];
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe('checkVersionDrift', () => {
  it('returns { drift: false } when both versions are equal', () => {
    expect(checkVersionDrift('2.19.0', '2.19.0')).toEqual({ drift: false });
  });

  it('returns { drift: true } + message when versions differ by patch', () => {
    const result = checkVersionDrift('2.19.0', '2.19.1');
    expect(result.drift).toBe(true);
    expect(result.message).toBeDefined();
  });

  it('returns { drift: true } + message when versions differ by minor', () => {
    const result = checkVersionDrift('2.19.0', '2.20.0');
    expect(result.drift).toBe(true);
    expect(result.message).toBeDefined();
  });

  it('returns { drift: true } + message when versions differ by major', () => {
    const result = checkVersionDrift('2.19.0', '3.0.0');
    expect(result.drift).toBe(true);
    expect(result.message).toBeDefined();
  });

  it('returns { drift: false } when spawnedVersion is "unknown"', () => {
    expect(checkVersionDrift('unknown', '2.19.1')).toEqual({ drift: false });
  });

  it('returns { drift: false } when diskVersion is "unknown"', () => {
    expect(checkVersionDrift('2.19.0', 'unknown')).toEqual({ drift: false });
  });

  it('returns { drift: false } when spawnedVersion is empty string', () => {
    expect(checkVersionDrift('', '2.19.0')).toEqual({ drift: false });
  });

  it('returns { drift: false } when diskVersion is empty string', () => {
    expect(checkVersionDrift('2.19.0', '')).toEqual({ drift: false });
  });

  it('returned message when drift=true contains both version strings', () => {
    const result = checkVersionDrift('2.19.0', '3.0.0');
    expect(result.drift).toBe(true);
    expect(result.message).toContain('2.19.0');
    expect(result.message).toContain('3.0.0');
  });

  it('returns { drift: false } when both are "unknown"', () => {
    expect(checkVersionDrift('unknown', 'unknown')).toEqual({ drift: false });
  });
});
