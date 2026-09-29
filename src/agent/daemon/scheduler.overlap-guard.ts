/**
 * Per-task in-flight guard for `CronScheduler`.
 *
 * Prevents stacked concurrent sessions when a cron tick fires while the
 * previous run of the same task is still active. A `skipped` telemetry record
 * (with `skipReason: 'overlap'`) is written instead of spawning a new session.
 *
 * The guard is executor-agnostic: it wraps `runOnce` before the cwd check and
 * before the executor dispatch, so it applies to `agent`, `shell`, and
 * `builtin` tasks alike.
 *
 * @module agent/daemon/scheduler.overlap-guard
 */

import { redactInlineSecrets } from '../session/prompt-dump.js';
import type { ScheduledTask } from './triggers.js';
import type { GateDecision } from './gates.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';

/**
 * Build a `status: 'skipped', skipReason: 'overlap'` telemetry record for a
 * tick that fired while a previous run of the same task was still in progress.
 */
export function makeOverlapSkipRecord(
  task: ScheduledTask,
  trigger: TelemetryTrigger,
  nowMs: number,
): TelemetryRecord {
  return {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: new Date(nowMs).toISOString(),
    // 0 by intent: the task never ran, so there is no elapsed session time to record.
    durationMs: 0,
    status: 'skipped',
    skipReason: 'overlap',
  };
}

/**
 * Build a `status: 'skipped'` telemetry record for a `sessionstart` trigger
 * that was gated (e.g. cooldown). The `skipReason` comes from the gate
 * decision so callers don't need to reach into `GateDecision` themselves.
 */
export function makeSessionStartSkipRecord(
  task: ScheduledTask,
  decision: GateDecision,
  nowMs: number,
): TelemetryRecord {
  return {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger: 'sessionstart',
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    status: 'skipped',
    ...(decision.skipReason !== undefined ? { skipReason: decision.skipReason } : {}),
  };
}
