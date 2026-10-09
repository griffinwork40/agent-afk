/**
 * Unit tests for scheduler.overlap-guard — covers both makeOverlapSkipRecord
 * and makeSessionStartSkipRecord, including secret redaction for each.
 */

import { describe, it, expect } from 'vitest';
import { makeOverlapSkipRecord, makeSessionStartSkipRecord, OverlapAlertLatch, formatOverlapAlertMessage } from './scheduler.overlap-guard.js';
import type { ScheduledTask } from './triggers.js';
import type { GateDecision } from './gates.js';

describe('makeSessionStartSkipRecord — secret redaction', () => {
  const nowMs = Date.now();

  const baseTask: ScheduledTask = {
    taskId: 'redact-test',
    trigger: 'sessionstart',
    cronExpression: undefined,
    command: '',
    executor: 'agent',
  };

  const decision: GateDecision = {
    fire: false,
    skipReason: 'cooldown',
  };

  it('redacts an OpenAI-style secret token from the command field', () => {
    // The sk- pattern requires ≥20 chars after "sk-" (see prompt-dump.ts INLINE_SECRET_PATTERNS).
    // "sk-proj-" + 20 alphanum chars satisfies the minimum; a realistic token is longer.
    const rawSecret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const task: ScheduledTask = { ...baseTask, command: `deploy --token ${rawSecret}` };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('preserves commands that contain no secrets', () => {
    const safeCommand = 'run-health-check --env staging';
    const task: ScheduledTask = { ...baseTask, command: safeCommand };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).toBe(safeCommand);
  });

  it('redacts an Anthropic API key (sk-ant-…) in the command field', () => {
    const rawSecret =
      'sk-ant-api03-abc123XYZABC123xyz-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000XXXX';
    const task: ScheduledTask = {
      ...baseTask,
      command: `deploy --anthropic-key ${rawSecret}`,
    };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('populates skipReason from the gate decision', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeSessionStartSkipRecord(task, { fire: false, skipReason: 'cooldown' }, nowMs);

    expect(record.skipReason).toBe('cooldown');
    expect(record.status).toBe('skipped');
    expect(record.trigger).toBe('sessionstart');
  });

  it('omits skipReason when the gate decision provides none', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeSessionStartSkipRecord(task, { fire: false }, nowMs);

    expect(record.skipReason).toBeUndefined();
  });
});

describe('makeOverlapSkipRecord', () => {
  const nowMs = Date.now();

  const baseTask: ScheduledTask = {
    taskId: 'overlap-test',
    trigger: 'cron',
    cronExpression: '*/5 * * * *',
    command: '',
    executor: 'agent',
  };

  it('returns a skipped record with skipReason: overlap', () => {
    const task: ScheduledTask = { ...baseTask, command: 'run-report' };
    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('overlap');
    expect(record.trigger).toBe('cron');
    expect(record.taskId).toBe('overlap-test');
    expect(record.durationMs).toBe(0);
  });

  it('sets durationMs to 0 (task never ran)', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.durationMs).toBe(0);
  });

  it('redacts an OpenAI-style secret token from the command field', () => {
    const rawSecret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const task: ScheduledTask = { ...baseTask, command: `deploy --token ${rawSecret}` };

    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('redacts an Anthropic API key (sk-ant-…) in the command field', () => {
    const rawSecret =
      'sk-ant-api03-abc123XYZABC123xyz-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000XXXX';
    const task: ScheduledTask = {
      ...baseTask,
      command: `deploy --anthropic-key ${rawSecret}`,
    };

    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('preserves commands that contain no secrets', () => {
    const safeCommand = 'run-health-check --env staging';
    const task: ScheduledTask = { ...baseTask, command: safeCommand };

    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.command).toBe(safeCommand);
  });

  it('includes cronExpression when the task has one', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeOverlapSkipRecord(task, 'cron', nowMs);

    expect(record.cronExpression).toBe('*/5 * * * *');
  });

  it('omits cronExpression when the task has none', () => {
    const task: ScheduledTask = { ...baseTask, cronExpression: undefined, command: 'noop' };
    const record = makeOverlapSkipRecord(task, 'sessionstart', nowMs);

    expect(record.cronExpression).toBeUndefined();
  });

  it('records the correct trigger when fired from a pull task', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeOverlapSkipRecord(task, 'pull', nowMs);

    expect(record.trigger).toBe('pull');
    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('overlap');
  });

  it('records the triggeredAt timestamp from nowMs', () => {
    const fixedMs = 1_700_000_000_000;
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeOverlapSkipRecord(task, 'cron', fixedMs);

    expect(record.triggeredAt).toBe(new Date(fixedMs).toISOString());
  });
});

describe('OverlapAlertLatch', () => {
  it('returns true for the first overlap of a task (new episode)', () => {
    const latch = new OverlapAlertLatch();
    expect(latch.shouldAlert('task-a')).toBe(true);
  });

  it('returns false for subsequent overlaps of the same task (same episode)', () => {
    const latch = new OverlapAlertLatch();
    latch.shouldAlert('task-a'); // first — alerts
    expect(latch.shouldAlert('task-a')).toBe(false);
    expect(latch.shouldAlert('task-a')).toBe(false);
  });

  it('tracks episodes independently per task id', () => {
    const latch = new OverlapAlertLatch();
    expect(latch.shouldAlert('task-a')).toBe(true);
    expect(latch.shouldAlert('task-b')).toBe(true); // separate episode
    expect(latch.shouldAlert('task-a')).toBe(false);
    expect(latch.shouldAlert('task-b')).toBe(false);
  });

  it('alerts again after clear() ends the episode', () => {
    const latch = new OverlapAlertLatch();
    latch.shouldAlert('task-a'); // opens episode
    latch.clear('task-a');       // task completed — episode over
    expect(latch.shouldAlert('task-a')).toBe(true); // new episode
  });

  it('clear() for an unknown task is a no-op', () => {
    const latch = new OverlapAlertLatch();
    expect(() => latch.clear('not-seen')).not.toThrow();
    // Still alerts normally afterwards
    expect(latch.shouldAlert('not-seen')).toBe(true);
  });

  it('_reset() clears all episodes so every task alerts again', () => {
    const latch = new OverlapAlertLatch();
    latch.shouldAlert('task-a');
    latch.shouldAlert('task-b');
    latch._reset();
    expect(latch.shouldAlert('task-a')).toBe(true);
    expect(latch.shouldAlert('task-b')).toBe(true);
  });
});

describe('formatOverlapAlertMessage', () => {
  it('includes the task id and command in the message', () => {
    const msg = formatOverlapAlertMessage('daily-report', 'run-report', '0 9 * * *');
    expect(msg).toContain('daily-report');
    expect(msg).toContain('run-report');
  });

  it('includes the cron expression when provided', () => {
    const msg = formatOverlapAlertMessage('t', 'cmd', '0 9 * * *');
    expect(msg).toContain('cron: 0 9 * * *');
  });

  it('omits the cron note when cron is undefined', () => {
    const msg = formatOverlapAlertMessage('t', 'cmd', undefined);
    expect(msg).not.toContain('cron:');
  });

  it('mentions that further overlaps will not alert', () => {
    const msg = formatOverlapAlertMessage('t', 'cmd', undefined);
    expect(msg).toMatch(/without alerts/i);
  });
});
