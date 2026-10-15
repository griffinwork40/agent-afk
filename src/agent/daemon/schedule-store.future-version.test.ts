/**
 * Scenario 5 (#3714): AFK upgraded while paused/scheduled work exists.
 *
 * Defect pinned: `loadSchedules` (schedule-store.ts:267-279) performs a bare
 * `JSON.parse(raw) as ScheduledTaskConfig[]` with no schema-version guard.
 * A `schedules.json` written by a FUTURE version of AFK (e.g. carrying a
 * top-level `"version": 999` field or per-entry unknown fields) is silently
 * accepted and cast rather than refused with a diagnostic error.
 *
 * Contrast: the SQLite state-store (`state-store.ts:127-133`) throws
 * explicitly when the on-disk schema version exceeds the current build.
 *
 * The tests below use `it.fails` to pin the CURRENT (broken) behaviour so
 * the suite stays green and the failing assertion flips automatically when
 * the version-guard is added to `loadSchedules`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { loadSchedules } from './schedule-store.js';

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

// ---------------------------------------------------------------------------
// Scenario 5 – future-version schedules.json
// ---------------------------------------------------------------------------

describe('schedule-store future-version guard (Scenario 5 / #3714)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSyncRetry(tmpDir);
  });

  // ── top-level version field ───────────────────────────────────────────────

  /**
   * DEFECT: loadSchedules silently accepts a file whose top-level structure
   * carries `"version": 999`.  The desired behaviour is to throw (or return a
   * typed error) so the caller can surface "upgrade required" rather than
   * silently loading entries authored for a schema the current code does not
   * understand.
   *
   * When the guard is added this `it.fails` will invert to a passing test.
   */
  it.fails(
    'refuses a schedules.json with a top-level future version (e.g. version:999)',
    () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
      const path = join(tmpDir, 'schedules.json');

      // A future AFK might wrap the array in an object with a version field.
      const futureFile = {
        version: 999,
        tasks: [futureEntry()],
      };
      writeFileSync(path, JSON.stringify(futureFile), 'utf-8');

      // DESIRED: throw an error mentioning the version mismatch.
      // CURRENT (defect): JSON.parse returns an object, the cast succeeds, and
      // loadSchedules returns [] (the object is not an array so length is 0 or
      // items are iterated with unexpected shapes) — no error is thrown.
      expect(() => loadSchedules(path)).toThrow(/version/i);
    },
  );

  // ── per-entry _schemaVersion field ───────────────────────────────────────

  /**
   * DEFECT: an individual entry carrying an explicit `_schemaVersion: 999`
   * (a plausible future field) is silently cast to ScheduledTaskConfig and
   * returned without complaint.
   *
   * Desired: entries whose schema version exceeds the current build are
   * refused (thrown or filtered with a diagnostic) rather than silently cast.
   */
  it.fails(
    'refuses entries that carry a future _schemaVersion field',
    () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
      const path = join(tmpDir, 'schedules.json');

      const entries = [futureEntry({ _schemaVersion: 999 })];
      writeFileSync(path, JSON.stringify(entries), 'utf-8');

      // DESIRED: throw (or return 0 entries with a logged/thrown diagnostic).
      // CURRENT: returns 1 entry — the unknown field is silently ignored.
      expect(() => loadSchedules(path)).toThrow(/version|schema/i);
    },
  );

  // ── baseline: current behaviour is documented (silent cast) ──────────────

  /**
   * Documents the CURRENT defective behaviour so readers understand what
   * `it.fails` is pinning against.  This test asserts the silent-cast path
   * and must be REMOVED (or inverted) when the version guard is added.
   *
   * Defect location: schedule-store.ts:271-272
   *   const raw = readFileSync(storePath, 'utf-8');
   *   return JSON.parse(raw) as ScheduledTaskConfig[];
   */
  it('CURRENT BEHAVIOUR (defect): silently casts a future-version array entry without throwing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    // Array of entries with an unknown future field — current code accepts this.
    const entries = [futureEntry({ _schemaVersion: 999, unknownFutureField: 'xyz' })];
    writeFileSync(path, JSON.stringify(entries), 'utf-8');

    // Does NOT throw — this is the bug.
    const loaded = loadSchedules(path);
    // The entry comes back as-is (silent cast).
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('future-task');
    // The unknown field is silently present on the cast object.
    expect((loaded[0] as unknown as Record<string, unknown>)['_schemaVersion']).toBe(999);
  });

  it('CURRENT BEHAVIOUR (defect): object-wrapped file (version+tasks) is silently cast — not refused', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-fv-'));
    const path = join(tmpDir, 'schedules.json');

    // Future format: object with version + tasks, not a bare array.
    const futureFile = { version: 999, tasks: [futureEntry()] };
    writeFileSync(path, JSON.stringify(futureFile), 'utf-8');

    // Does NOT throw — another facet of the same bug.
    // JSON.parse returns a plain object; the bare `as ScheduledTaskConfig[]`
    // cast succeeds at compile time, but at runtime the caller receives the
    // raw object (not an array). No error is surfaced.
    const loaded = loadSchedules(path);
    // The result is NOT an array — silent data loss / wrong type.
    expect(Array.isArray(loaded)).toBe(false);
    // The tasks field is accessible as a property, proving the object was
    // returned verbatim rather than refused.
    expect((loaded as unknown as Record<string, unknown>)['version']).toBe(999);
  });
});
