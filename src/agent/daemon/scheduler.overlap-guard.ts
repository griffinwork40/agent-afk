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
import { describeBudgetSkip, type BudgetGateSkip } from './budget-gate.js';

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
 * Build a `status: 'skipped', skipReason: 'budget-over'` telemetry record for
 * an agent task skipped because subscription usage is over the configured threshold.
 */
export function makeBudgetSkipRecord(
  task: ScheduledTask,
  trigger: TelemetryTrigger,
  nowMs: number,
  skip: BudgetGateSkip,
): TelemetryRecord {
  return {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    status: 'skipped',
    skipReason: 'budget-over',
    errorMessage: describeBudgetSkip(skip, nowMs),
  };
}

/**
 * Build a `status: 'skipped', skipReason: 'telemetry-unwritable'` telemetry
 * record for an agent sessionstart task that was blocked because the telemetry
 * file exists but is not writable (W_OK probe failed). Cooldown records cannot
 * be saved in this state, so firing the task would cause it to re-fire on
 * every daemon restart.
 */
export function makeTelemetryUnwritableSkipRecord(
  task: ScheduledTask,
  nowMs: number,
  errorDescription: string,
): TelemetryRecord {
  return {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger: 'sessionstart',
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    status: 'skipped',
    skipReason: 'telemetry-unwritable',
    errorMessage: `Telemetry file not writable: ${redactInlineSecrets(errorDescription)}`,
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
