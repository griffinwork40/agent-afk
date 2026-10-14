/**
 * Unit tests for src/service/version-skew.ts
 *
 * Tests cover:
 *  - sidecar write (happy path + filesystem error swallowing)
 *  - sidecar read (happy path, missing file, malformed JSON, stale PID)
 *  - compareVersions (match, skew, unknown)
 *  - formatVersionLine (all three cases)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Mock paths.ts to redirect sidecar writes to a temp directory.
// ---------------------------------------------------------------------------

const tmpBase = join(tmpdir(), `afk-version-skew-test-${process.pid}`);

vi.mock('../paths.js', () => ({
  getServiceStartupSidecarPath: (name: string) =>
    join(tmpBase, 'service-startup', `${name}.json`),
  // Other paths.ts exports used transitively — keep safe stubs.
  getAfkStateDir: () => join(tmpBase, 'state'),
  getAfkHome: () => tmpBase,
}));

import {
  writeServiceStartupSidecar,
  readServiceStartupSidecar,
  compareVersions,
  formatVersionLine,
  type ServiceStartupSidecar,
  type VersionSkewResult,
} from './version-skew.js';

const sidecarDir = join(tmpBase, 'service-startup');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alwaysRunning(_pid: number): boolean {
  return true;
}

function neverRunning(_pid: number): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(sidecarDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeServiceStartupSidecar
// ---------------------------------------------------------------------------

describe('writeServiceStartupSidecar', () => {
  it('writes a valid JSON sidecar to the expected path', () => {
    const now = () => '2025-01-01T00:00:00.000Z';
    writeServiceStartupSidecar('daemon', '5.305.5', 12345, now);

    const path = join(sidecarDir, 'daemon.json');
    expect(existsSync(path)).toBe(true);

    const raw = JSON.parse(require('fs').readFileSync(path, 'utf-8')) as ServiceStartupSidecar;
    expect(raw.version).toBe('5.305.5');
    expect(raw.pid).toBe(12345);
    expect(raw.startedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('writes separate files for telegram and daemon', () => {
    writeServiceStartupSidecar('daemon', '5.300.0', 1001);
    writeServiceStartupSidecar('telegram', '5.300.0', 1002);
    expect(existsSync(join(sidecarDir, 'daemon.json'))).toBe(true);
    expect(existsSync(join(sidecarDir, 'telegram.json'))).toBe(true);
  });

  it('swallows filesystem errors without throwing', () => {
    // Place a file where the sidecar would be written, so the write fails
    // with EISDIR or similar when the directory can't be created.
    // We simulate this by placing a regular file at the sidecar path itself
    // and then trying to write to that path as if it were a JSON file —
    // this is a no-op (it would just overwrite), so instead we test that
    // calling writeServiceStartupSidecar never propagates an exception even
    // when the underlying mkdirSync/writeFileSync would throw. We verify
    // this via the module's own error swallowing by spying on mkdirSync.
    const fsMod = require('fs');
    const orig = fsMod.mkdirSync;
    fsMod.mkdirSync = () => { throw new Error('simulated EPERM'); };
    try {
      expect(() => writeServiceStartupSidecar('daemon', '5.305.5', 99)).not.toThrow();
    } finally {
      fsMod.mkdirSync = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// readServiceStartupSidecar
// ---------------------------------------------------------------------------

describe('readServiceStartupSidecar', () => {
  it('returns the sidecar when PID is alive', () => {
    writeServiceStartupSidecar('daemon', '5.300.1', 42);
    const result = readServiceStartupSidecar('daemon', alwaysRunning);
    expect(result).toBeDefined();
    expect(result?.version).toBe('5.300.1');
    expect(result?.pid).toBe(42);
  });

  it('returns undefined when the sidecar file is absent', () => {
    expect(readServiceStartupSidecar('daemon', alwaysRunning)).toBeUndefined();
  });

  it('returns undefined when PID is no longer running (stale sidecar)', () => {
    writeServiceStartupSidecar('daemon', '5.300.1', 99);
    expect(readServiceStartupSidecar('daemon', neverRunning)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    writeFileSync(join(sidecarDir, 'daemon.json'), 'NOT JSON', 'utf-8');
    expect(readServiceStartupSidecar('daemon', alwaysRunning)).toBeUndefined();
  });

  it('returns undefined for JSON missing required fields', () => {
    writeFileSync(join(sidecarDir, 'daemon.json'), JSON.stringify({ pid: 1 }), 'utf-8');
    expect(readServiceStartupSidecar('daemon', alwaysRunning)).toBeUndefined();
  });

  it('returns undefined for an empty version string', () => {
    writeFileSync(
      join(sidecarDir, 'daemon.json'),
      JSON.stringify({ version: '', pid: 1, startedAt: '2025-01-01T00:00:00Z' }),
      'utf-8',
    );
    expect(readServiceStartupSidecar('daemon', alwaysRunning)).toBeUndefined();
  });

  it('returns undefined for a non-finite PID', () => {
    writeFileSync(
      join(sidecarDir, 'daemon.json'),
      JSON.stringify({ version: '1.0.0', pid: NaN, startedAt: '2025-01-01T00:00:00Z' }),
      'utf-8',
    );
    expect(readServiceStartupSidecar('daemon', alwaysRunning)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
  it('returns match when versions are identical', () => {
    const r = compareVersions('5.305.5', '5.305.5') as VersionSkewResult;
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.version).toBe('5.305.5');
  });

  it('returns skew when versions differ', () => {
    const r = compareVersions('5.300.1', '5.305.5') as VersionSkewResult;
    expect(r.kind).toBe('skew');
    if (r.kind === 'skew') {
      expect(r.runningVersion).toBe('5.300.1');
      expect(r.installedVersion).toBe('5.305.5');
    }
  });

  it('returns skew for a rollback (installed older than running)', () => {
    const r = compareVersions('5.305.5', '5.300.1') as VersionSkewResult;
    expect(r.kind).toBe('skew');
  });

  it.each([
    [undefined, '5.305.5'],
    ['unknown', '5.305.5'],
    ['', '5.305.5'],
    ['5.305.5', 'unknown'],
    ['5.305.5', ''],
    ['5.305.5', '0.0.0-unknown'],
  ])('returns unknown when either version is unavailable (%s, %s)', (running, installed) => {
    expect(compareVersions(running, installed as string).kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatVersionLine
// ---------------------------------------------------------------------------

describe('formatVersionLine', () => {
  it('formats a match as the bare version string', () => {
    const r = formatVersionLine({ kind: 'match', version: '5.305.5' }, 'daemon');
    expect(r).toBe('v5.305.5');
  });

  it('formats a skew with running/installed and restart hint', () => {
    const r = formatVersionLine(
      { kind: 'skew', runningVersion: '5.300.1', installedVersion: '5.305.5' },
      'daemon',
    );
    expect(r).toContain('running v5.300.1');
    expect(r).toContain('installed v5.305.5');
    expect(r).toContain('⚠');
    expect(r).toContain('afk service restart daemon');
  });

  it('formats unknown with restart recommendation', () => {
    const r = formatVersionLine({ kind: 'unknown' }, 'telegram');
    expect(r).toContain('unknown');
    expect(r).toContain('afk service restart telegram');
  });

  it('names the service correctly for telegram', () => {
    const r = formatVersionLine(
      { kind: 'skew', runningVersion: '5.300.1', installedVersion: '5.305.5' },
      'telegram',
    );
    expect(r).toContain('afk service restart telegram');
  });
});
