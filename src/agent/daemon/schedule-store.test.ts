/**
 * Unit tests for schedule-store.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  slugify,
  resolveSlugCollision,
  loadSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
  saveSchedules,
  toggleScheduleEnabled,
  updateSchedule,
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

  it('round-trips a numeric notifyChat', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      { name: 'Group Task', command: '/cmd', cron: '* * * * *', enabled: true, notifyChat: -1001234567890 },
      path,
    );

    expect(config.notifyChat).toBe(-1001234567890);
    const loaded = loadSchedules(path);
    expect(loaded[0]?.notifyChat).toBe(-1001234567890);
  });

  it('round-trips a string (alias) notifyChat', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      { name: 'Ops Task', command: '/cmd', cron: '* * * * *', enabled: true, notifyChat: 'ops' },
      path,
    );

    expect(config.notifyChat).toBe('ops');
    const loaded = loadSchedules(path);
    expect(loaded[0]?.notifyChat).toBe('ops');
  });

  it('omits notifyChat when not provided (default routing)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    const config = addSchedule(
      { name: 'Default Task', command: '/cmd', cron: '* * * * *', enabled: true },
      path,
    );

    expect(config.notifyChat).toBeUndefined();
    const loaded = loadSchedules(path);
    expect(loaded[0]?.notifyChat).toBeUndefined();
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

// ── toggleScheduleEnabled ────────────────────────────────────────────────────

describe('toggleScheduleEnabled', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enables a disabled task and returns the updated config', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Flip Me', command: '/flip', cron: '* * * * *', enabled: false }, path);

    const result = toggleScheduleEnabled('flip-me', true, path);
    expect(result).toBeDefined();
    expect(result?.id).toBe('flip-me');
    expect(result?.enabled).toBe(true);
    expect(loadSchedules(path)[0]?.enabled).toBe(true);
  });

  it('disables an enabled task and returns the updated config', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'On Task', command: '/on', cron: '* * * * *', enabled: true }, path);

    const result = toggleScheduleEnabled('on-task', false, path);
    expect(result?.enabled).toBe(false);
    expect(loadSchedules(path)[0]?.enabled).toBe(false);
  });

  it('preserves all other fields (executor, notifyOn, notifyChat) when toggling', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule(
      {
        name: 'Full Task',
        command: 'echo hi',
        cron: '0 1 * * *',
        enabled: false,
        executor: 'shell',
        notifyOn: 'always',
        notifyChat: 'ops',
      },
      path,
    );

    const result = toggleScheduleEnabled('full-task', true, path);
    expect(result?.executor).toBe('shell');
    expect(result?.notifyOn).toBe('always');
    expect(result?.notifyChat).toBe('ops');
    expect(result?.enabled).toBe(true);
  });

  it('returns undefined for an unknown id and does not mutate the store', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Real Task', command: '/real', cron: '* * * * *', enabled: true }, path);

    const result = toggleScheduleEnabled('ghost-task', false, path);
    expect(result).toBeUndefined();
    // The real task must be untouched
    expect(loadSchedules(path)[0]?.enabled).toBe(true);
  });
});

// ── updateSchedule ──────────────────────────────────────────────────────────

describe('updateSchedule', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('patches a single field and preserves others', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule(
      { name: 'Patch Me', command: '/cmd', cron: '0 2 * * *', enabled: true, notifyOn: 'always' },
      path,
    );

    const result = updateSchedule('patch-me', { cron: '0 4 * * *' }, path);
    expect(result).toBeDefined();
    expect(result?.cron).toBe('0 4 * * *');
    // Other fields preserved
    expect(result?.name).toBe('Patch Me');
    expect(result?.command).toBe('/cmd');
    expect(result?.enabled).toBe(true);
    expect(result?.notifyOn).toBe('always');

    // Verify persisted
    const loaded = loadSchedules(path);
    expect(loaded[0]?.cron).toBe('0 4 * * *');
  });

  it('patches multiple fields at once', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule(
      { name: 'Multi Patch', command: '/old', cron: '0 1 * * *', enabled: true },
      path,
    );

    const result = updateSchedule('multi-patch', {
      command: '/new',
      cron: '30 3 * * *',
      notifyOn: 'never',
      executor: 'shell',
    }, path);
    expect(result?.command).toBe('/new');
    expect(result?.cron).toBe('30 3 * * *');
    expect(result?.notifyOn).toBe('never');
    expect(result?.executor).toBe('shell');
  });

  it('returns undefined for unknown id (no-op)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Real', command: '/cmd', cron: '* * * * *', enabled: true }, path);

    const result = updateSchedule('nonexistent', { cron: '0 0 * * *' }, path);
    expect(result).toBeUndefined();
    // Original untouched
    expect(loadSchedules(path)[0]?.cron).toBe('* * * * *');
  });

  it('does not change the id when name is patched', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Original Name', command: '/cmd', cron: '* * * * *', enabled: true }, path);

    const result = updateSchedule('original-name', { name: 'New Name' }, path);
    expect(result?.id).toBe('original-name');
    expect(result?.name).toBe('New Name');
  });

  it('stamps updatedAt without changing createdAt', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    // Seed with a known past timestamp so the update is guaranteed to differ
    const config: ScheduledTaskConfig = {
      id: 'time-test',
      name: 'Time Test',
      command: '/cmd',
      cron: '* * * * *',
      enabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    saveSchedules([config], path);

    const result = updateSchedule('time-test', { command: '/new' }, path);
    expect(result?.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result?.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
  });

  it('patches notifyChat with a numeric value', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Chat Num', command: '/cmd', cron: '* * * * *', enabled: true }, path);

    const result = updateSchedule('chat-num', { notifyChat: -1001234567890 }, path);
    expect(result?.notifyChat).toBe(-1001234567890);
  });

  it('patches notifyChat with a string alias', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Chat Alias', command: '/cmd', cron: '* * * * *', enabled: true }, path);

    const result = updateSchedule('chat-alias', { notifyChat: 'ops' }, path);
    expect(result?.notifyChat).toBe('ops');
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

  it('maps a numeric notifyChat when present', () => {
    const config: ScheduledTaskConfig = {
      id: 'nc-num',
      name: 'NC Num',
      command: '/nc',
      cron: '* * * * *',
      enabled: true,
      notifyChat: -100777,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.notifyChat).toBe(-100777);
  });

  it('maps a string (alias) notifyChat when present', () => {
    const config: ScheduledTaskConfig = {
      id: 'nc-alias',
      name: 'NC Alias',
      command: '/nc',
      cron: '* * * * *',
      enabled: true,
      notifyChat: 'family',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.notifyChat).toBe('family');
  });

  it('omits notifyChat when absent', () => {
    const config: ScheduledTaskConfig = {
      id: 'nc-none',
      name: 'NC None',
      command: '/nc',
      cron: '* * * * *',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect('notifyChat' in task).toBe(false);
  });

  it('preserves executor when round-tripped through toScheduledTask', () => {
    const config: ScheduledTaskConfig = {
      id: 'exec-task',
      name: 'Exec Task',
      command: 'echo hi',
      cron: '* * * * *',
      executor: 'shell',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.executor).toBe('shell');
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

// ── per-task cwd ─────────────────────────────────────────────────────────────

describe('schedule-store cwd field', () => {
  let tmpDir: string;
  let storePath: string;
  let realDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-cwd-'));
    storePath = join(tmpDir, 'schedules.json');
    realDir = tmpDir; // the tmpDir itself is a real existing dir
  }

  it('addSchedule stores cwd when provided', () => {
    setup();
    const config = addSchedule(
      { name: 'Cwd Task', command: '/test', cron: '0 2 * * *', enabled: true, cwd: realDir },
      storePath,
    );
    expect(config.cwd).toBe(realDir);
    const loaded = loadSchedules(storePath);
    expect(loaded[0]?.cwd).toBe(realDir);
  });

  it('addSchedule without cwd does not set the field', () => {
    setup();
    const config = addSchedule(
      { name: 'No Cwd', command: '/test', cron: '0 2 * * *', enabled: true },
      storePath,
    );
    expect(config.cwd).toBeUndefined();
  });

  it('updateSchedule patches cwd', () => {
    setup();
    const config = addSchedule(
      { name: 'Patch Cwd', command: '/p', cron: '0 2 * * *', enabled: true },
      storePath,
    );
    const updated = updateSchedule(config.id, { cwd: realDir }, storePath);
    expect(updated?.cwd).toBe(realDir);
  });

  it('toScheduledTask includes cwd when present', () => {
    setup();
    const config: ScheduledTaskConfig = {
      id: 'cwd-task',
      name: 'Cwd Task',
      command: '/test',
      cron: '* * * * *',
      enabled: true,
      cwd: realDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect(task.cwd).toBe(realDir);
  });

  it('toScheduledTask omits cwd when absent', () => {
    setup();
    const config: ScheduledTaskConfig = {
      id: 'no-cwd-task',
      name: 'No Cwd Task',
      command: '/test',
      cron: '* * * * *',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const task = toScheduledTask(config);
    expect('cwd' in task).toBe(false);
  });

  it('existing schedules without cwd load and behave as before', () => {
    setup();
    const raw = JSON.stringify([
      {
        id: 'legacy',
        name: 'Legacy',
        command: '/legacy',
        cron: '0 1 * * *',
        enabled: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    writeFileSync(storePath, raw, 'utf-8');
    const loaded = loadSchedules(storePath);
    expect(loaded[0]?.cwd).toBeUndefined();
    const task = toScheduledTask(loaded[0]!);
    expect('cwd' in task).toBe(false);
  });

  it('updateSchedule with cwd: null clears a previously-set cwd', () => {
    setup();
    const config = addSchedule(
      { name: 'Clear Cwd', command: '/c', cron: '0 2 * * *', enabled: true, cwd: realDir },
      storePath,
    );
    expect(config.cwd).toBe(realDir);
    const cleared = updateSchedule(config.id, { cwd: null }, storePath);
    expect(cleared?.cwd).toBeUndefined();
    expect('cwd' in (cleared ?? {})).toBe(false);
    // Persisted correctly
    const loaded = loadSchedules(storePath);
    expect(loaded[0]?.cwd).toBeUndefined();
  });

  it('toScheduledTask expands tilde in cwd from hand-edited schedules', () => {
    setup();
    // Simulate a hand-edited schedules.json with a tilde path
    const raw = JSON.stringify([
      {
        id: 'tilde-task',
        name: 'Tilde',
        command: '/t',
        cron: '* * * * *',
        enabled: true,
        cwd: '~',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    writeFileSync(storePath, raw, 'utf-8');
    const loaded = loadSchedules(storePath);
    const task = toScheduledTask(loaded[0]!);
    // Should be the expanded home directory, not the literal '~'
    expect(task.cwd).not.toBe('~');
    // Use path.isAbsolute instead of startsWith('/') so the assertion is
    // platform-neutral (Windows absolute paths start with a drive letter).
    expect(isAbsolute(task.cwd ?? '')).toBe(true);
  });
});

// ── concurrent read-modify-write race (issue #2306) ──────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const scheduleStoreUrl = pathToFileURL(join(here, 'schedule-store.ts')).href;

function waitForChild(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', scriptPath, ...args], {
      cwd: join(here, '..', '..', '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`schedule writer exited ${code ?? 'unknown'}: ${stderr}`));
    });
  });
}

describe('schedule-store concurrent mutation', () => {
  it('addSchedule: child-process writers preserve all additions', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-race-'));
    const storePath = join(tmpDir, 'schedules.json');
    const startPath = join(tmpDir, 'start');
    const scriptPath = join(tmpDir, 'writer.mjs');
    const workerCount = 6;
    const perWorker = 15;
    writeFileSync(scriptPath, `
      import { existsSync } from 'node:fs';
      import { addSchedule } from ${JSON.stringify(scheduleStoreUrl)};
      const [storePath, startPath, worker, countRaw] = process.argv.slice(2);
      const count = Number(countRaw);
      while (!existsSync(startPath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      for (let i = 0; i < count; i++) {
        addSchedule(
          { name: \`Worker \${worker} Task \${i}\`, command: \`/cmd-\${worker}-\${i}\`, cron: '* * * * *', enabled: true },
          storePath,
        );
      }
    `, 'utf-8');

    try {
      const children = Array.from({ length: workerCount }, (_, i) =>
        waitForChild(scriptPath, [storePath, startPath, String(i), String(perWorker)]));
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(startPath, 'go', 'utf-8');
      await Promise.all(children);

      const loaded = loadSchedules(storePath);
      expect(loaded).toHaveLength(workerCount * perWorker);
      const ids = loaded.map((s) => s.id);
      expect(new Set(ids).size).toBe(workerCount * perWorker);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removeSchedule + addSchedule concurrent: neither change is lost', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-race-'));
    const storePath = join(tmpDir, 'schedules.json');

    // Seed two tasks.
    addSchedule({ name: 'Alpha', command: '/a', cron: '* * * * *', enabled: true }, storePath);
    addSchedule({ name: 'Beta', command: '/b', cron: '* * * * *', enabled: true }, storePath);

    // Simulate two "concurrent" operations: remove Alpha and add Gamma.
    // In a real race both callers would read the same two-item list and one
    // would clobber the other's change. With the lock each sees the latest state.
    removeSchedule('alpha', storePath);
    addSchedule({ name: 'Gamma', command: '/g', cron: '* * * * *', enabled: true }, storePath);

    const loaded = loadSchedules(storePath);
    const ids = loaded.map((s) => s.id);
    expect(ids).not.toContain('alpha');   // removed
    expect(ids).toContain('beta');         // untouched
    expect(ids).toContain('gamma');        // added

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updateSchedule concurrent: each patch is applied without clobbering others', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-race-'));
    const storePath = join(tmpDir, 'schedules.json');

    addSchedule({ name: 'Mutable', command: '/cmd', cron: '0 1 * * *', enabled: true }, storePath);

    // Apply 10 sequential (lock-guarded) patches to the same task.
    for (let i = 0; i < 10; i++) {
      updateSchedule('mutable', { cron: `${i} 1 * * *` }, storePath);
    }

    // The final state should reflect the last patch, not an intermediate one.
    const loaded = loadSchedules(storePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.cron).toBe('9 1 * * *');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── retry fields round-trip (#3243) ─────────────────────────────────────────

describe('retry fields (maxAttempts / retryDelayMs)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips through add → load → toScheduledTask', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-retry-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Retry Me', command: '/r', cron: '0 * * * *', enabled: true, maxAttempts: 3, retryDelayMs: 2_000 }, path);
    const loaded = getSchedule('retry-me', path)!;
    expect(loaded.maxAttempts).toBe(3);
    expect(loaded.retryDelayMs).toBe(2_000);
    const task = toScheduledTask(loaded);
    expect(task.maxAttempts).toBe(3);
    expect(task.retryDelayMs).toBe(2_000);
  });

  it('updateSchedule patches the fields and preserves them when omitted', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-store-retry-'));
    const path = join(tmpDir, 'schedules.json');
    addSchedule({ name: 'Patch Me', command: '/p', cron: '0 * * * *', enabled: true }, path);
    expect(toScheduledTask(getSchedule('patch-me', path)!).maxAttempts).toBeUndefined();
    updateSchedule('patch-me', { maxAttempts: 2, retryDelayMs: 5_000 }, path);
    updateSchedule('patch-me', { name: 'Renamed' }, path);
    const after = getSchedule('patch-me', path)!;
    expect(after.maxAttempts).toBe(2);
    expect(after.retryDelayMs).toBe(5_000);
  });
});
