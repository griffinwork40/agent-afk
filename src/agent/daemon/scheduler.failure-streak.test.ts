/**
 * Tests for the failure-streak tracker and its integration with CronScheduler.
 *
 * "Done when" items tested here (issue #5146):
 *   1. N consecutive failures produce exactly one escalation message.
 *   2. A subsequent success produces exactly one recovery message and resets streak.
 *   3. Delivery integration is covered in scheduler.streak-integration.test.ts.
 *   4. `blocked` status counts the same as `error` toward the streak.
 *   5. `skipped` status does NOT count toward the streak.
 *
 * @module agent/daemon/scheduler.failure-streak.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FailureStreakTracker,
  DEFAULT_FAILURE_STREAK_THRESHOLD,
  REESCALATION_INTERVAL,
  isFailureStatus,
  formatStreakEscalation,
  formatStreakRecovery,
  applyStreakLogic,
  resolveThreshold,
} from './scheduler.failure-streak.js';
import type { TelemetryRecord } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecord(status: TelemetryRecord['status'], opts: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    taskId: 'test-task',
    command: 'run-test',
    trigger: 'cron',
    triggeredAt: new Date().toISOString(),
    durationMs: 100,
    status,
    ...opts,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'test-task',
    command: 'run-test',
    trigger: 'cron',
    cronExpression: '* * * * *',
    notifyOn: 'failure',
    ...overrides,
  };
}

// ─── Unit tests: FailureStreakTracker ─────────────────────────────────────────

describe('FailureStreakTracker', () => {
  let tracker: FailureStreakTracker;

  beforeEach(() => {
    tracker = new FailureStreakTracker();
  });

  it('returns none for a single success', () => {
    const result = tracker.record('t1', makeTask(), makeRecord('success'));
    expect(result.action).toBe('none');
  });

  it('returns none for a single failure below threshold', () => {
    const result = tracker.record('t1', makeTask(), makeRecord('error'));
    expect(result.action).toBe('none');
  });

  it('escalates exactly once when streak reaches default threshold (3)', () => {
    const task = makeTask();
    tracker.record('t1', task, makeRecord('error'));
    tracker.record('t1', task, makeRecord('error'));
    const result = tracker.record('t1', task, makeRecord('error'));
    expect(result.action).toBe('escalate');
    expect(result.message).toContain('3 runs in a row');
    // Fourth failure has no new escalation; ordinary notices continue
    const r4 = tracker.record('t1', task, makeRecord('error'));
    expect(r4.action).toBe('none');
  });

  it('"blocked" status counts toward the streak', () => {
    const task = makeTask();
    tracker.record('t1', task, makeRecord('error'));
    tracker.record('t1', task, makeRecord('blocked'));
    const result = tracker.record('t1', task, makeRecord('error'));
    expect(result.action).toBe('escalate');
  });

  it('"skipped" status does NOT count toward the streak', () => {
    const task = makeTask();
    tracker.record('t1', task, makeRecord('error'));
    tracker.record('t1', task, makeRecord('skipped'));
    tracker.record('t1', task, makeRecord('error'));
    // Only 2 real failures — should not have escalated yet
    const noEsc = tracker.record('t1', task, makeRecord('skipped'));
    expect(noEsc.action).toBe('none');
    // Now add the third real failure
    const esc = tracker.record('t1', task, makeRecord('error'));
    expect(esc.action).toBe('escalate');
  });

  it('recovery fires exactly once after streak is cleared by success', () => {
    const task = makeTask();
    for (let i = 0; i < DEFAULT_FAILURE_STREAK_THRESHOLD; i++) {
      tracker.record('t1', task, makeRecord('error'));
    }
    // success → recover
    const recover = tracker.record('t1', task, makeRecord('success'));
    expect(recover.action).toBe('recover');
    expect(recover.message).toContain('recovered');
    // Another success → no recover (streak already cleared)
    const r2 = tracker.record('t1', task, makeRecord('success'));
    expect(r2.action).toBe('none');
  });

  it('no recovery when streak never reached threshold', () => {
    const task = makeTask();
    tracker.record('t1', task, makeRecord('error')); // 1 — below threshold 3
    const r = tracker.record('t1', task, makeRecord('success'));
    expect(r.action).toBe('none');
  });

  it('re-escalates every REESCALATION_INTERVAL failures after initial escalation', () => {
    const task = makeTask();
    for (let i = 0; i < DEFAULT_FAILURE_STREAK_THRESHOLD; i++) {
      tracker.record('t1', task, makeRecord('error'));
    }
    // Add REESCALATION_INTERVAL - 1 more failures (all should be 'none')
    for (let i = 0; i < REESCALATION_INTERVAL - 1; i++) {
      const r = tracker.record('t1', task, makeRecord('error'));
      expect(r.action).toBe('none');
    }
    // The REESCALATION_INTERVAL-th extra failure triggers re-escalation
    const reEsc = tracker.record('t1', task, makeRecord('error'));
    expect(reEsc.action).toBe('re-escalate');
    expect(reEsc.message).toContain('STILL failing');
  });

  it('per-task threshold override respected', () => {
    const task = makeTask({ failureStreakThreshold: 1 });
    const result = tracker.record('t1', task, makeRecord('error'), 1);
    expect(result.action).toBe('escalate');
  });

  it('listBreachedStreaks returns tasks at or above threshold', () => {
    const task = makeTask();
    for (let i = 0; i < DEFAULT_FAILURE_STREAK_THRESHOLD; i++) {
      tracker.record('t1', task, makeRecord('error'));
    }
    tracker.record('t2', makeTask({ taskId: 't2' }), makeRecord('error', { taskId: 't2' }));
    const breached = tracker.listBreachedStreaks();
    expect(breached.map((b) => b.taskId)).toContain('t1');
    expect(breached.map((b) => b.taskId)).not.toContain('t2');
  });
});

// ─── Unit tests: helpers ─────────────────────────────────────────────────────

describe('isFailureStatus', () => {
  it('error → true', () => expect(isFailureStatus('error')).toBe(true));
  it('blocked → true', () => expect(isFailureStatus('blocked')).toBe(true));
  it('success → false', () => expect(isFailureStatus('success')).toBe(false));
  it('skipped → false', () => expect(isFailureStatus('skipped')).toBe(false));
});

describe('formatStreakEscalation', () => {
  it('includes taskId, count, failingSince', () => {
    const msg = formatStreakEscalation('my-task', 'My Task', 5, '2026-11-01T00:00:00.000Z', 'exit 1', '0 2 * * *');
    expect(msg).toContain('my-task');
    expect(msg).toContain('5 runs in a row');
    expect(msg).toContain('2026-11-01');
    expect(msg).toContain('exit 1');
  });
});

describe('formatStreakRecovery', () => {
  it('includes taskId and streak count', () => {
    const msg = formatStreakRecovery('my-task', undefined, 9, '2026-11-01T00:00:00.000Z', undefined);
    expect(msg).toContain('my-task');
    expect(msg).toContain('recovered');
    expect(msg).toContain('9 consecutive');
  });
});

describe('resolveThreshold', () => {
  it('returns DEFAULT_FAILURE_STREAK_THRESHOLD when task has none', () => {
    expect(resolveThreshold(undefined)).toBe(DEFAULT_FAILURE_STREAK_THRESHOLD);
    expect(resolveThreshold(makeTask())).toBe(DEFAULT_FAILURE_STREAK_THRESHOLD);
  });
  it('returns per-task threshold when set', () => {
    expect(resolveThreshold(makeTask({ failureStreakThreshold: 5 }))).toBe(5);
  });
  it('clamps to minimum 1', () => {
    expect(resolveThreshold(makeTask({ failureStreakThreshold: 0 }))).toBe(1);
  });
});

// ─── Integration: applyStreakLogic ────────────────────────────────────────────

describe('applyStreakLogic', () => {
  let tracker: FailureStreakTracker;
  const task = makeTask({ notifyOn: 'failure' });

  beforeEach(() => {
    tracker = new FailureStreakTracker();
  });

  it('skipped records get a decision without advancing the streak', () => {
    const record = makeRecord('skipped', { skipReason: 'overlap' });
    const { persistedRecord, effectiveTask } = applyStreakLogic(tracker, task, record, undefined, true);
    expect(persistedRecord.notificationDecision?.state).toBe('not-due');
    expect(effectiveTask).toBe(task);
  });

  it('stamps decision: "failure" on error records before threshold (notifyOn: failure)', () => {
    const record = makeRecord('error');
    const { persistedRecord } = applyStreakLogic(tracker, task, record, undefined, true);
    expect(persistedRecord.notificationDecision).toEqual({ state: 'due', kind: 'failure' });
  });

  it('stamps decision: "escalation" on the threshold-breach run', () => {
    // Pre-fill streak to threshold - 1
    for (let i = 0; i < DEFAULT_FAILURE_STREAK_THRESHOLD - 1; i++) {
      applyStreakLogic(tracker, task, makeRecord('error'), undefined, true);
    }
    const { persistedRecord, effectiveTask, effectiveDetails } = applyStreakLogic(
      tracker, task, makeRecord('error'), undefined, true,
    );
    expect(persistedRecord.notificationDecision).toEqual({ state: 'due', kind: 'escalation' });
    expect(effectiveTask?.notifyOn).toBe('always');
    expect(effectiveDetails?.responseText).toContain('runs in a row');
  });

  it('stamps decision: "recovery" on the first success after escalation', () => {
    for (let i = 0; i < DEFAULT_FAILURE_STREAK_THRESHOLD; i++) {
      applyStreakLogic(tracker, task, makeRecord('error'), undefined, true);
    }
    const { persistedRecord, effectiveTask } = applyStreakLogic(
      tracker, task, makeRecord('success'), undefined, true,
    );
    expect(persistedRecord.notificationDecision).toEqual({ state: 'due', kind: 'recovery' });
    expect(effectiveTask?.notifyOn).toBe('always');
  });

  it('stamps failingSince from the first consecutive failure', () => {
    // First failure already carries the durable streak start.
    const r1 = applyStreakLogic(tracker, task, makeRecord('error'), undefined, true);
    expect(r1.persistedRecord.failingSince).toBeDefined();
    // Second failure — failingSince should appear
    const r2 = applyStreakLogic(tracker, task, makeRecord('error'), undefined, true);
    expect(r2.persistedRecord.failingSince).toBeDefined();
  });

  it('records policy suppression when notifyOn is never', () => {
    const neverTask = makeTask({ notifyOn: 'never' });
    const { persistedRecord } = applyStreakLogic(tracker, neverTask, makeRecord('error'), undefined, true);
    expect(persistedRecord.notificationDecision).toEqual({ state: 'suppressed', kind: 'failure', reason: 'policy-never' });
  });

  it('due decision when no callback configured', () => {
    const { persistedRecord } = applyStreakLogic(tracker, task, makeRecord('error'), undefined, false);
    expect(persistedRecord.notificationDecision).toEqual({ state: 'due', kind: 'failure', reason: 'no-callback' });
  });
});
