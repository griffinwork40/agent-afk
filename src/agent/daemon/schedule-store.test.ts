/**
 * Unit tests for schedule-store.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugify,
  resolveSlugCollision,
  loadSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
  saveSchedules,
  toScheduledTask,
  type ScheduledTaskConfig,
} from './schedule-store.js';

// ── slugify ──────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('slugifies basic names', () => {
    expect(slugify('Nightly Forge')).toBe('nightly-forge');
  });

  it('strips special chars', () => {
    expect(slugify('My Task! #1')).toBe('my-task-1');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--foo--')).toBe('foo');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('foo   bar')).toBe('foo-bar');
  });

  it('handles all-numeric name', () => {
    expect(slugify('123')).toBe('123');
  });
});

// ── resolveSlugCollision ─────────────────────────────────────────────────────

describe('resolveSlugCollision', () => {
  it('returns base when no collision', () => {
    expect(resolveSlugCollision('foo', ['bar', 'baz'])).toBe('foo');
  });

  it('returns base-2 on first collision', () => {
    expect(resolveSlugCollision('foo', ['foo', 'bar'])).toBe('foo-2');
  });

  it('returns base-3 on second collision', () => {
    expect(resolveSlugCollision('foo', ['foo', 'foo-2'])).toBe('foo-3');
  });

  it('skips gaps (finds first available)', () => {
    // foo-2 taken, foo-3 not taken → returns foo-2... wait, no: iterates from 2
    // foo exists, foo-2 exists → tries foo-3
    expect(resolveSlugCollision('foo', ['foo', 'foo-2', 'foo-3'])).toBe('foo-4');
  });
});

// ── loadSchedules ────────────────────────────────────────────────────────────

describe('loadSchedules', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] for missing file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const result = loadSchedules(join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual([]);
  });

  it('returns [] and logs stderr for malformed JSON', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    writeFileSync(path, 'this is not valid json', 'utf-8');
    const result = loadSchedules(path);
    expect(result).toEqual([]);
  });

  it('returns array for valid JSON', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config: ScheduledTaskConfig = {
      id: 'test-task',
      name: 'Test Task',
      command: '/test',
      cron: '* * * * *',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify([config]), 'utf-8');
    const result = loadSchedules(path);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('test-task');
  });
});

// ── addSchedule round-trip ───────────────────────────────────────────────────

describe('addSchedule', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reloads correctly', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      {
        name: 'Nightly Forge',
        command: '/forge-friction --auto',
        cron: '0 2 * * *',
        enabled: true,
      },
      path,
    );

    expect(config.id).toBe('nightly-forge');
    expect(config.name).toBe('Nightly Forge');
    expect(config.command).toBe('/forge-friction --auto');
    expect(config.createdAt).toBeTruthy();
    expect(config.updatedAt).toBeTruthy();

    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('nightly-forge');
  });

  it('resolves slug collision when adding duplicate name', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const first = addSchedule({ name: 'My Task', command: '/cmd', cron: '* * * * *', enabled: true }, path);
    const second = addSchedule({ name: 'My Task', command: '/cmd2', cron: '* * * * *', enabled: true }, path);

    expect(first.id).toBe('my-task');
    expect(second.id).toBe('my-task-2');

    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(2);
  });

  // notifyOn default is materialized at write time — see addSchedule's
  // doc-comment for the rationale (the runtime guard treats undefined as
  // legacy pass-through, so we lock in 'failure' for user-created tasks).
  it("defaults notifyOn to 'failure' when omitted", () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      { name: 'Quiet Task', command: '/cmd', cron: '* * * * *', enabled: true },
      path,
    );

    expect(config.notifyOn).toBe('failure');
    const loaded = loadSchedules(path);
    expect(loaded[0]?.notifyOn).toBe('failure');
  });

  it('preserves explicit notifyOn when provided', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      { name: 'Loud Task', command: '/cmd', cron: '* * * * *', enabled: true, notifyOn: 'always' },
      path,
    );

    expect(config.notifyOn).toBe('always');
    const loaded = loadSchedules(path);
    expect(loaded[0]?.notifyOn).toBe('always');
  });
});

// ── removeSchedule ───────────────────────────────────────────────────────────

describe('removeSchedule', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true and removes entry', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Task A', command: '/a', cron: '* * * * *', enabled: true }, path);

    const result = removeSchedule('task-a', path);
    expect(result).toBe(true);
    expect(loadSchedules(path)).toHaveLength(0);
  });

  it('returns false for unknown id (no-op)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Task A', command: '/a', cron: '* * * * *', enabled: true }, path);

    const result = removeSchedule('nonexistent', path);
    expect(result).toBe(false);
    expect(loadSchedules(path)).toHaveLength(1);
  });
});

// ── getSchedule ──────────────────────────────────────────────────────────────

describe('getSchedule', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns config by id', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Find Me', command: '/find', cron: '* * * * *', enabled: true }, path);
    const found = getSchedule('find-me', path);
    expect(found).toBeDefined();
    expect(found?.name).toBe('Find Me');
  });

  it('returns undefined for unknown id', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    expect(getSchedule('nope', path)).toBeUndefined();
  });
});

// ── toScheduledTask ──────────────────────────────────────────────────────────

describe('toScheduledTask', () => {
  it('maps config fields to ScheduledTask correctly', () => {
    const config: ScheduledTaskConfig = {
      id: 'foo',
      name: 'Foo',
      command: '/foo',
      cron: '* * * * *',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.taskId).toBe('foo');
    expect(task.cronExpression).toBe('* * * * *');
    expect(task.trigger).toBe('cron');
    expect(task.command).toBe('/foo');
  });

  it('uses explicit trigger when provided', () => {
    const config: ScheduledTaskConfig = {
      id: 'bar',
      name: 'Bar',
      command: '/bar',
      cron: '0 * * * *',
      trigger: 'both',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.trigger).toBe('both');
  });

  it('maps notifyOn when present', () => {
    const config: ScheduledTaskConfig = {
      id: 'baz',
      name: 'Baz',
      command: '/baz',
      cron: '* * * * *',
      enabled: true,
      notifyOn: 'failure',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect((task as { notifyOn?: string }).notifyOn).toBe('failure');
  });

  it('saveSchedules + loadSchedules round-trips correctly', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config: ScheduledTaskConfig = {
      id: 'round-trip',
      name: 'Round Trip',
      command: '/rt',
      cron: '30 4 * * *',
      enabled: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    };
    saveSchedules([config], path);
    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(config);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
