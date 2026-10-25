/**
 * Tests for the malformed runAt/expiresAt gate path (#4011).
 *
 * When a stored `schedules.json` has a hand-edited invalid ISO 8601 value for
 * `runAt` or `expiresAt`, `evaluateRunAtGate` must return `{ kind: 'malformed' }`
 * so the scheduler skips the task and warns the operator — rather than silently
 * firing the task (bad runAt) or silently never expiring it (bad expiresAt).
 *
 * @module agent/daemon/scheduler.runat-gate.malformed.test
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateRunAtGate, makeMalformedSkipRecord } from './scheduler.runat-gate.js';
import { CronScheduler } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => undefined },
  }),
}));

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// evaluateRunAtGate unit tests
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-06-01T12:00:00Z');

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'test-task',
    command: 'do work',
    trigger: 'cron',
    cronExpression: '0 * * * *',
    ...overrides,
  };
}

describe('evaluateRunAtGate — malformed expiresAt', () => {
  it('returns malformed when expiresAt is not a valid ISO string', () => {
    const task = makeTask({ expiresAt: 'not-a-date' });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.field).toBe('expiresAt');
      expect(result.value).toBe('not-a-date');
      expect(result.record.status).toBe('skipped');
      expect(result.record.skipReason).toBe('malformed');
      expect(result.record.errorMessage).toContain('expiresAt');
      expect(result.record.errorMessage).toContain('not-a-date');
    }
  });

  it('returns malformed for a locale-style expiresAt (01/02/2027)', () => {
    const task = makeTask({ expiresAt: '01/02/2027' });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed for an empty-string expiresAt', () => {
    const task = makeTask({ expiresAt: '' });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
  });

  it('does NOT return malformed for a valid past expiresAt (returns expired instead)', () => {
    const task = makeTask({ expiresAt: '2026-01-01T00:00:00Z' }); // before NOW_MS
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('expired');
  });

  it('does NOT return malformed for a valid future expiresAt (returns pass)', () => {
    const task = makeTask({ expiresAt: '2030-01-01T00:00:00Z' });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('pass');
  });
});

describe('evaluateRunAtGate — malformed runAt', () => {
  it('returns malformed when runAt is not a valid ISO string', () => {
    const task = makeTask({ runAt: 'tomorrow', cronExpression: undefined });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.field).toBe('runAt');
      expect(result.value).toBe('tomorrow');
      expect(result.record.skipReason).toBe('malformed');
      expect(result.record.errorMessage).toContain('runAt');
      expect(result.record.errorMessage).toContain('tomorrow');
    }
  });

  it('returns malformed for a numeric-string runAt', () => {
    const task = makeTask({ runAt: '1748000000000', cronExpression: undefined });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
  });

  it('malformed expiresAt takes priority over a malformed runAt', () => {
    const task = makeTask({ expiresAt: 'bad-expiry', runAt: 'bad-runat', cronExpression: undefined });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.field).toBe('expiresAt');
    }
  });

  it('does NOT return malformed for a valid future runAt (returns not-yet)', () => {
    const task = makeTask({ runAt: '2030-01-01T00:00:00Z', cronExpression: undefined });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('not-yet');
  });

  it('does NOT return malformed for a valid past runAt (returns pass)', () => {
    const task = makeTask({ runAt: '2020-01-01T00:00:00Z', cronExpression: undefined });
    const result = evaluateRunAtGate(task, 'cron', NOW_MS);
    expect(result.kind).toBe('pass');
  });
});

describe('makeMalformedSkipRecord', () => {
  it('builds a well-formed skipped record with skipReason malformed', () => {
    const task = makeTask();
    const record = makeMalformedSkipRecord(task, 'cron', NOW_MS, 'expiresAt', 'garbage');
    expect(record.taskId).toBe('test-task');
    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('malformed');
    expect(record.durationMs).toBe(0);
    expect(record.errorMessage).toContain('expiresAt');
    expect(record.errorMessage).toContain('garbage');
    expect(record.triggeredAt).toBe(new Date(NOW_MS).toISOString());
  });
});

// ---------------------------------------------------------------------------
// CronScheduler integration: warns + writes telemetry for malformed values
// ---------------------------------------------------------------------------

describe('CronScheduler — malformed runAt/expiresAt integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-malformed-'));
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeScheduler(telemetryPath: string) {
    return new CronScheduler({
      telemetryPath,
      sessionFactory: () => { throw new Error('must not spawn session'); },
      budgetGate: async () => ({ skip: false }),
    });
  }

  it('emits console.warn and writes skipped telemetry for malformed expiresAt', async () => {
    const telemetryPath = join(dir, 'telemetry.jsonl');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scheduler = makeScheduler(telemetryPath);

    // Register the task directly with a malformed expiresAt, bypassing
    // validateScheduledTask (which would normally reject it). This simulates
    // a hand-edited schedules.json that the store loads without re-validation.
    const task: ScheduledTask = {
      taskId: 'bad-expiry',
      command: 'periodic work',
      trigger: 'cron',
      cronExpression: '0 * * * *',
      expiresAt: 'not-a-date',
    };
    // Bypass register() validation by inserting directly into the registry.
    // NOTE: this unsafe cast intentionally models post-startup corruption —
    // a task that was valid at register time but whose persisted store entry
    // was subsequently hand-edited to an invalid ISO 8601 value. The startup
    // path (daemon.ts) now also quarantines tasks that fail validateScheduledTask
    // on the way in, so both entry points are covered. (#4052)
    (scheduler as unknown as { registry: Map<string, { task: ScheduledTask }> })
      .registry.set('bad-expiry', { task });

    const record = await scheduler.tick('bad-expiry');
    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('malformed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bad-expiry'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expiresAt'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-a-date'));

    // Telemetry must be written so the operator can audit it.
    const { readFileSync } = await import('node:fs');
    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const written = JSON.parse(line) as { status: string; skipReason: string };
    expect(written.status).toBe('skipped');
    expect(written.skipReason).toBe('malformed');

    await scheduler.stop();
  });

  it('emits console.warn and writes skipped telemetry for malformed runAt', async () => {
    const telemetryPath = join(dir, 'telemetry.jsonl');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scheduler = makeScheduler(telemetryPath);

    const task: ScheduledTask = {
      taskId: 'bad-runat',
      command: 'one shot',
      trigger: 'cron',
      runAt: '2026/06/01', // locale-style — not valid ISO 8601
    };
    (scheduler as unknown as { registry: Map<string, { task: ScheduledTask }> })
      .registry.set('bad-runat', { task });

    const record = await scheduler.tick('bad-runat');
    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('malformed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('runAt'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2026/06/01'));

    await scheduler.stop();
  });
});
