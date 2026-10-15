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
});
