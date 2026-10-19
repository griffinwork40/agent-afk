/**
 * Regression tests: read-modify-write operations must never overwrite a
 * schedules.json that exists but cannot be read as a schedule array.
 *
 * Before the fix, `addSchedule` / `updateSchedule` / `removeSchedule` used the
 * lenient `loadSchedules`, which returns [] on invalid JSON and casts any
 * parsed value as an array. A hand-edit typo therefore made the next mutation
 * write `[<new task>]` over the file, deleting every existing schedule.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import {
  addSchedule,
  loadSchedules,
  removeSchedule,
  toggleScheduleEnabled,
  UnreadableSchedulesError,
  updateSchedule,
} from './schedule-store.js';

const BASE = {
  name: 'New Task',
  command: '/forge',
  cron: '0 2 * * *',
  enabled: true,
} as const;

// A hand-edit typo: trailing comma after the last array element.
const INVALID_JSON =
  '[{"id":"nightly","name":"Nightly","command":"/forge","cron":"0 2 * * *","enabled":true,' +
  '"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},]\n';

const NON_ARRAY_JSON = JSON.stringify({
  schedules: [{ id: 'nightly', name: 'Nightly', command: '/forge', cron: '0 2 * * *', enabled: true }],
});

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-sched-unreadable-'));
  storePath = join(dir, 'schedules.json');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSyncRetry(dir);
});

describe('read-modify-write on an unreadable schedules.json', () => {
  it('addSchedule on an invalid-JSON file throws and leaves the original content intact', () => {
    writeFileSync(storePath, INVALID_JSON);
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(/not valid JSON/);
    expect(readFileSync(storePath, 'utf-8')).toBe(INVALID_JSON);
  });

  it('addSchedule on a non-array JSON file throws and leaves the original content intact', () => {
    writeFileSync(storePath, NON_ARRAY_JSON);
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(/not a JSON array/);
    expect(readFileSync(storePath, 'utf-8')).toBe(NON_ARRAY_JSON);
  });

  it('the error names the path and tells the operator to repair or move the file', () => {
    writeFileSync(storePath, INVALID_JSON);
    let message = '';
    try {
      addSchedule({ ...BASE }, storePath);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(storePath);
    expect(message).toMatch(/repair/i);
    expect(message).toMatch(/move/i);
  });

  it.each([
    ['updateSchedule', () => updateSchedule('nightly', { name: 'Renamed' }, storePath)],
    ['toggleScheduleEnabled', () => toggleScheduleEnabled('nightly', false, storePath)],
    ['removeSchedule', () => removeSchedule('nightly', storePath)],
  ])('%s refuses to write over an invalid-JSON file', (_name, run) => {
    writeFileSync(storePath, INVALID_JSON);
    expect(run).toThrow(/not valid JSON/);
    expect(readFileSync(storePath, 'utf-8')).toBe(INVALID_JSON);
  });

  it.each([
    ['updateSchedule', () => updateSchedule('nightly', { name: 'Renamed' }, storePath)],
    ['removeSchedule', () => removeSchedule('nightly', storePath)],
  ])('%s refuses to write over a non-array file', (_name, run) => {
    writeFileSync(storePath, NON_ARRAY_JSON);
    expect(run).toThrow(/not a JSON array/);
    expect(readFileSync(storePath, 'utf-8')).toBe(NON_ARRAY_JSON);
  });

  it('releases the lock after refusing, so a repaired file can be mutated', () => {
    writeFileSync(storePath, INVALID_JSON);
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow();
    expect(existsSync(`${storePath}.lock`)).toBe(false);
    writeFileSync(storePath, '[]\n');
    expect(addSchedule({ ...BASE }, storePath).id).toBe('new-task');
  });

  it('a missing file is still treated as empty by addSchedule', () => {
    expect(addSchedule({ ...BASE }, storePath).id).toBe('new-task');
    expect(loadSchedules(storePath)).toHaveLength(1);
  });

  it('loadSchedules (read-only) stays lenient: invalid JSON still returns []', () => {
    writeFileSync(storePath, INVALID_JSON);
    expect(loadSchedules(storePath)).toEqual([]);
  });

  it('loadSchedules returns [] and does not throw SchedulesVersionError for a primitive top-level JSON value', () => {
    writeFileSync(storePath, '42');
    expect(() => loadSchedules(storePath)).not.toThrow();
    expect(loadSchedules(storePath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-entry _schemaVersion guard in loadSchedulesForWrite (#3970)
// ---------------------------------------------------------------------------

describe('read-modify-write rejects entries with future _schemaVersion', () => {
  it('addSchedule throws UnreadableSchedulesError when any entry has a future _schemaVersion', () => {
    const futureEntry = {
      id: 'future-task',
      name: 'Future Task',
      command: '/future',
      cron: '0 2 * * *',
      enabled: true,
      _schemaVersion: 999,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    writeFileSync(storePath, JSON.stringify([futureEntry]));
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(UnreadableSchedulesError);
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(/schema/i);
  });

  it('addSchedule leaves the file byte-for-byte intact when refusing a future-schema entry', () => {
    const futureEntry = {
      id: 'future-task', name: 'Future Task', command: '/future',
      cron: '0 2 * * *', enabled: true, _schemaVersion: 999,
      createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
    };
    const original = JSON.stringify([futureEntry]);
    writeFileSync(storePath, original);
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(UnreadableSchedulesError);
    expect(readFileSync(storePath, 'utf-8')).toBe(original);
  });

  it.each([
    ['updateSchedule', (p: string) => updateSchedule('future-task', { name: 'Renamed' }, p)],
    ['removeSchedule', (p: string) => removeSchedule('future-task', p)],
    ['toggleScheduleEnabled', (p: string) => toggleScheduleEnabled('future-task', false, p)],
  ])('%s throws UnreadableSchedulesError for future-schema entries', (_name, run) => {
    const futureEntry = {
      id: 'future-task', name: 'Future Task', command: '/future',
      cron: '0 2 * * *', enabled: true, _schemaVersion: 999,
      createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
    };
    writeFileSync(storePath, JSON.stringify([futureEntry]));
    expect(() => run(storePath)).toThrow(UnreadableSchedulesError);
  });

  it('accepts entries with current _schemaVersion (= 1) in write path', () => {
    const currentEntry = {
      id: 'current-task', name: 'Current Task', command: '/current',
      cron: '0 3 * * *', enabled: true, _schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(storePath, JSON.stringify([currentEntry]));
    // removeSchedule should succeed (returns false — ID not matching BASE name slug)
    expect(() => removeSchedule('current-task', storePath)).not.toThrow();
  });

  it('releases the lock after refusing a future-schema file', () => {
    const futureEntry = {
      id: 'future-task', name: 'Future Task', command: '/future',
      cron: '0 2 * * *', enabled: true, _schemaVersion: 999,
      createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
    };
    writeFileSync(storePath, JSON.stringify([futureEntry]));
    expect(() => addSchedule({ ...BASE }, storePath)).toThrow(UnreadableSchedulesError);
    expect(existsSync(`${storePath}.lock`)).toBe(false);
  });
});
