/**
 * Scenario 5 (#3714): AFK upgraded while paused/scheduled work exists.
 *
 * Regression tests for the version guard added to `loadSchedules` by #3821.
 * A `schedules.json` written by a FUTURE version of AFK (carrying a top-level
 * `"version": 999` field or per-entry `_schemaVersion: 999`) is now refused
 * with a `SchedulesVersionError` instead of being silently cast.
 *
 * Contrast: the SQLite state-store (`state-store.ts`) throws explicitly when
 * the on-disk schema version exceeds the current build — this fix brings
 * `schedule-store.ts` in line with that pattern.
 *
 * Backward-compat invariant (hard requirement): existing unversioned files
 * (bare JSON array, no version field) written by current/older releases MUST
 * continue to load without error.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { loadSchedules, SchedulesVersionError, SCHEDULES_SCHEMA_VERSION } from './schedule-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid entry shape that a future AFK version might write. */
function futureEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'future-task',
    name: 'Future Task',
    command: '/future',
    cron: '0 2 * * *',
    enabled: true,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Minimal valid legacy entry (no version fields). */
function legacyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'legacy-task',
    name: 'Legacy Task',
    command: '/legacy',
    cron: '0 3 * * *',
    enabled: true,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 5 – future-version schedules.json
// ---------------------------------------------------------------------------

describe('schedule-store future-version guard (Scenario 5 / #3714)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSyncRetry(tmpDir);
  });

  // ── future version refused ────────────────────────────────────────────────

  it('refuses a schedules.json with a top-level future version (e.g. version:999)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    const futureFile = {
      version: 999,
      tasks: [futureEntry()],
    };
    writeFileSync(path, JSON.stringify(futureFile), 'utf-8');

    expect(() => loadSchedules(path)).toThrow(SchedulesVersionError);
    expect(() => loadSchedules(path)).toThrow(/version/i);
  });

  it('refuses entries that carry a future _schemaVersion field', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    const entries = [futureEntry({ _schemaVersion: 999 })];
    writeFileSync(path, JSON.stringify(entries), 'utf-8');

    expect(() => loadSchedules(path)).toThrow(SchedulesVersionError);
    expect(() => loadSchedules(path)).toThrow(/version|schema/i);
  });

  it('SchedulesVersionError carries the path', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(path, JSON.stringify({ version: 999, tasks: [] }), 'utf-8');

    let caught: unknown;
    try {
      loadSchedules(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchedulesVersionError);
    expect((caught as SchedulesVersionError).path).toBe(path);
    expect((caught as SchedulesVersionError).fileVersion).toBe(999);
  });

  it('does NOT rewrite the file when refusing a future-version file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    const original = JSON.stringify({ version: 999, tasks: [futureEntry()] });
    writeFileSync(path, original, 'utf-8');

    try { loadSchedules(path); } catch { /* expected */ }

    // File must be byte-for-byte intact — never silently overwritten.
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  // ── backward compatibility: legacy unversioned files load unchanged ────────

  it('loads a legacy unversioned bare-array file without error', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(path, JSON.stringify([legacyEntry()]), 'utf-8');

    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('legacy-task');
  });

  it('loads an empty legacy bare-array file without error', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(path, '[]', 'utf-8');

    expect(loadSchedules(path)).toEqual([]);
  });

  it('loads multiple legacy entries without error', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(
      path,
      JSON.stringify([legacyEntry({ id: 'a' }), legacyEntry({ id: 'b' })]),
      'utf-8',
    );

    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('loads an entry with unknown extra fields (legacy forward-compat) without error', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    // An entry with an extra field that is not _schemaVersion: tolerated.
    writeFileSync(path, JSON.stringify([legacyEntry({ unknownFutureField: 'xyz' })]), 'utf-8');

    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
  });

  // ── current version accepted ──────────────────────────────────────────────

  it('accepts an entry with _schemaVersion equal to SCHEDULES_SCHEMA_VERSION', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(
      path,
      JSON.stringify([legacyEntry({ _schemaVersion: SCHEDULES_SCHEMA_VERSION })]),
      'utf-8',
    );

    expect(loadSchedules(path)).toHaveLength(1);
  });

  it('accepts an entry with _schemaVersion of 0 (historical minimum)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(path, JSON.stringify([legacyEntry({ _schemaVersion: 0 })]), 'utf-8');

    expect(loadSchedules(path)).toHaveLength(1);
  });

  // ── malformed JSON still returns [] (existing contract preserved) ─────────

  it('returns [] for malformed JSON (existing contract unchanged)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    writeFileSync(path, 'not valid json!!!', 'utf-8');

    // loadSchedules catches JSON.parse errors and returns [] — unchanged by #3821.
    expect(loadSchedules(path)).toEqual([]);
  });
});
