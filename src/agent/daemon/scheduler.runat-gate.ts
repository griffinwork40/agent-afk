/**
 * runAt / expiresAt gate helpers for CronScheduler.
 *
 * Extracted from scheduler.ts to keep it under the 350-code-line ceiling.
 * Callers import the two evaluation functions; the gate result is a discriminated
 * union so the scheduler can act on it without reaching back into this module.
 *
 * @module agent/daemon/scheduler.runat-gate
 */

import { makeExpiredSkipRecord, makeNotYetSkipRecord } from './scheduler.overlap-guard.js';
import { toggleScheduleEnabled } from './schedule-store.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';

export type RunAtGateResult =
  | { kind: 'pass' }
  | { kind: 'not-yet'; record: TelemetryRecord }
  | { kind: 'expired'; record: TelemetryRecord };

/**
 * Evaluate `expiresAt` and `runAt` gates for one scheduler tick.
 *
 * - `'pass'`    — no gate blocks execution; fall through to run the task.
 * - `'not-yet'` — `runAt` has not been reached; return the record silently
 *                 (no telemetry write — pre-fire polling is silent by design).
 * - `'expired'` — `expiresAt` has passed; caller must write telemetry, then
 *                 call `applyAutoDisable` to disable + unregister the task.
 *
 * Contract: `nowMs` must equal the scheduler's `this.now()` call-site value so
 * the gate and the telemetry timestamp are derived from the same instant.
 */
export function evaluateRunAtGate(
  task: ScheduledTask,
  trigger: TelemetryTrigger,
  nowMs: number,
): RunAtGateResult {
  // expiresAt check takes priority: a task that is both expired and at its
  // runAt instant should be recorded as expired, not fired once.
  if (task.expiresAt !== undefined) {
    const expiryMs = Date.parse(task.expiresAt);
    if (!isNaN(expiryMs) && nowMs >= expiryMs) {
      return { kind: 'expired', record: makeExpiredSkipRecord(task, trigger, nowMs) };
    }
  }

  if (task.runAt !== undefined) {
    const runAtMs = Date.parse(task.runAt);
    if (!isNaN(runAtMs) && nowMs < runAtMs) {
      return { kind: 'not-yet', record: makeNotYetSkipRecord(task, trigger, nowMs) };
    }
  }

  return { kind: 'pass' };
}

/**
 * Auto-disable a task in the persistent store and unregister it from the live
 * scheduler. Called after an `'expired'` gate result or after a `runAt`
 * one-shot has fired. Best-effort: store write failures are swallowed so they
 * cannot crash a tick; the `unregister` callback is always invoked.
 *
 * Contract: `unregister` must be the scheduler's own `unregister` method so
 * the cron timer is stopped alongside the registry entry removal.
 */
export function applyAutoDisable(taskId: string, unregister: (id: string) => void): void {
  try { toggleScheduleEnabled(taskId, false); } catch { /* best-effort */ }
  unregister(taskId);
}
