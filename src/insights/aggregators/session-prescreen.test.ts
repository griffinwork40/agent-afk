/**
 * Unit tests for the sidecarPredatesWindow helper (#4913).
 *
 * Strategy: synthetic temp-dir with real sidecar files and controlled mtimes.
 * No real AFK_HOME reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarPredatesWindow } from './session-prescreen.js';

let tmpDir: string;

beforeEach(() => {
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
    writeSidecar('boundary-sess', cutoffMs);
    expect(sidecarPredatesWindow('boundary-sess', tmpDir, cutoffMs)).toBe(false);
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
});
