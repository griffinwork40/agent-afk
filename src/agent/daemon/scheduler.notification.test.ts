import { describe, it, expect, vi } from 'vitest';
import { notificationDecision, dispatchCompletion } from './scheduler.notification.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord } from './scheduler.js';
const row = (status: TelemetryRecord['status']): TelemetryRecord => ({ taskId: 't', command: 'x', trigger: 'cron', triggeredAt: '2026-01-01', durationMs: 1, status });
describe('notification decision truth table', () => {
  for (const notifyOn of [undefined, 'always', 'failure', 'never'] as const) {
    for (const status of ['success', 'error', 'blocked', 'skipped'] as const) {
      for (const hasCallback of [true, false]) {
        it(`${String(notifyOn)} / ${status} / callback ${hasCallback}`, () => {
          const task: ScheduledTask = { taskId: 't', command: 'x', trigger: 'pull', ...(notifyOn !== undefined ? { notifyOn } : {}) };
          const expected = notifyOn === 'never' ? 'suppressed' : notifyOn === 'failure' && !['error', 'blocked'].includes(status) ? 'not-due' : 'due';
          const decision = notificationDecision(row(status), task, hasCallback);
          expect(decision.state).toBe(expected);
          if (expected === 'due' && !hasCallback) expect(decision.reason).toBe('no-callback');
          const cb = vi.fn();
          dispatchCompletion(row(status), hasCallback ? cb : undefined, task);
          expect(cb).toHaveBeenCalledTimes(expected === 'due' && hasCallback ? 1 : 0);
        });
      }
    }
  }
});
