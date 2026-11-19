/**
 * Unit tests for the sidecarPredatesWindow helper (#4913).
 *
 * Strategy: synthetic temp-dir with real sidecar files and controlled mtimes.
 * No real AFK_HOME reads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarPredatesWindow } from './session-prescreen.js';
import { debugLog, isDebugEnabled } from '../../utils/debug.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDebugEnabled).mockReturnValue(false);
  tmpDir = join(
    tmpdir(),
    `afk-prescreen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSidecar(sessionId: string, mtimeMs: number): string {
  const filePath = join(tmpDir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify({ sessionId }), 'utf-8');
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

describe('sidecarPredatesWindow', () => {
  it('returns true when sidecar mtime is strictly before cutoff', () => {
    writeSidecar('old-sess', cutoffMs - 1000);
    expect(sidecarPredatesWindow('old-sess', tmpDir, cutoffMs)).toBe(true);
  });

  it('returns false when sidecar mtime equals cutoff (boundary — do not skip)', () => {
    // Use the file's actual mtime as the cutoff so the boundary assertion is
    // independent of utimes precision. On Node 22, utimesSync can truncate
    // sub-millisecond fractions causing statSync to return a value slightly
    // below the requested mtime — a ~50 % coin-flip failure on that runtime.
    const filePath = writeSidecar('boundary-sess', cutoffMs);
    const actualMtime = statSync(filePath).mtimeMs;
    expect(sidecarPredatesWindow('boundary-sess', tmpDir, actualMtime)).toBe(false);
  });

  it('returns false when sidecar mtime is after cutoff (recent session)', () => {
    writeSidecar('recent-sess', Date.now() - 1000);
    expect(sidecarPredatesWindow('recent-sess', tmpDir, cutoffMs)).toBe(false);
  });

  it('returns false when sidecar file does not exist (safe fallback)', () => {
    // File is never written — stat will fail.
    expect(sidecarPredatesWindow('nonexistent', tmpDir, cutoffMs)).toBe(false);
  });

  it('returns false when sessionsDir does not exist (safe fallback)', () => {
    expect(sidecarPredatesWindow('any', '/nonexistent/dir/xyz', cutoffMs)).toBe(false);
  });

  it.each(['../outside', 'nested/session', '..\\outside', 'nested\\session'])(
    'rejects path separators without statting: %s', (sessionId) => {
      expect(sidecarPredatesWindow(sessionId, tmpDir, cutoffMs)).toBe(false);
      expect(statSync).not.toHaveBeenCalled();
    },
  );

  it('logs every skip with mtime, cutoff delta, and cumulative stat metrics', () => {
    vi.mocked(isDebugEnabled).mockReturnValue(true);
    writeSidecar('old-debug', cutoffMs - 1000);
    writeSidecar('recent-debug', cutoffMs + 1000);

    expect(sidecarPredatesWindow('old-debug', tmpDir, cutoffMs)).toBe(true);
    const first = vi.mocked(debugLog).mock.calls[0][1] as {
      statCount: number; totalStatMs: number;
    };
    expect(debugLog).toHaveBeenLastCalledWith('[session-prescreen] skip', {
      sessionId: 'old-debug', mtimeMs: expect.any(Number), cutoffMs,
      deltaMs: expect.closeTo(-1000, 0), statCount: expect.any(Number),
      statMs: expect.any(Number), totalStatMs: expect.any(Number),
    });

    // Successful non-skips and failed stats also count toward the loop cost.
    expect(sidecarPredatesWindow('recent-debug', tmpDir, cutoffMs)).toBe(false);
    expect(debugLog).toHaveBeenCalledTimes(1);
    expect(sidecarPredatesWindow('missing-debug', tmpDir, cutoffMs)).toBe(false);
    expect(sidecarPredatesWindow('old-debug', tmpDir, cutoffMs)).toBe(true);
    expect(debugLog).toHaveBeenCalledTimes(3);
    const last = vi.mocked(debugLog).mock.calls[2][1] as {
      statCount: number; totalStatMs: number;
    };
    // Use a delta assertion so the test stays correct even if an earlier test
    // increments the module-level counter (e.g. if DEBUG is enabled upstream).
    expect(last.statCount - first.statCount).toBe(3);
    expect(last.totalStatMs).toBeGreaterThanOrEqual(first.totalStatMs);
  });

  it('logs stat failures at DEBUG before conservatively falling back', () => {
    vi.mocked(isDebugEnabled).mockReturnValue(true);
    expect(sidecarPredatesWindow('missing-debug', tmpDir, cutoffMs)).toBe(false);
    expect(debugLog).toHaveBeenCalledWith(
      '[session-prescreen] stat failed; falling back',
      expect.objectContaining({
        sessionId: 'missing-debug', error: expect.objectContaining({ code: 'ENOENT' }),
        statCount: expect.any(Number), statMs: expect.any(Number),
        totalStatMs: expect.any(Number),
      }),
    );
  });

  it('does not log or read the performance clock when DEBUG is disabled', () => {
    writeSidecar('quiet-old', cutoffMs - 1000);
    writeSidecar('quiet-recent', cutoffMs + 1000);
    const clock = vi.spyOn(performance, 'now');
    try {
      expect(sidecarPredatesWindow('quiet-old', tmpDir, cutoffMs)).toBe(true);
      expect(sidecarPredatesWindow('quiet-recent', tmpDir, cutoffMs)).toBe(false);
      expect(sidecarPredatesWindow('quiet-missing', tmpDir, cutoffMs)).toBe(false);
      expect(debugLog).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
