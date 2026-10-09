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

// ─── Overlap alert latch ──────────────────────────────────────────────────────

/**
 * One Telegram alert per overlap episode instead of one per skipped tick.
 *
 * An episode begins when a task's previous run is still in progress when the
 * next cron tick fires, and ends when that task completes successfully (the
 * latch is cleared per-task on any non-skipped run). The first overlap skip
 * of an episode alerts; subsequent overlapping ticks within the same episode
 * are silent so a slow task does not spam the operator on every tick.
 *
 * Invariant: daemon-process state only. A daemon restart re-alerts once,
 * which is the intended trade (never silent after a restart, never a flood).
 *
 * Per-task key: the latch is keyed by `taskId` so concurrent overlap episodes
 * for different tasks are independently tracked.
 */
export class OverlapAlertLatch {
  private readonly alerted = new Set<string>();

  /**
   * Returns `true` when this is the first overlap skip for `taskId` in the
   * current episode (caller should send the Telegram alert). Subsequent calls
   * for the same `taskId` return `false` until {@link clear} is called.
   */
  shouldAlert(taskId: string): boolean {
    if (this.alerted.has(taskId)) return false;
    this.alerted.add(taskId);
    return true;
  }

  /**
   * Clear the latch for a task. Call when the task completes successfully so
   * the next overlap episode alerts again.
   */
  clear(taskId: string): void {
    this.alerted.delete(taskId);
  }

  /** Exposed for tests: reset the full latch state between test cases. */
  _reset(): void {
    this.alerted.clear();
  }
}

/**
 * Plain-text Telegram notice for the FIRST overlap skip of an episode (no
 * markup, safe in every parse mode). Later ticks in the same episode are
 * suppressed by {@link OverlapAlertLatch}.
 *
 * @param taskId   The task whose previous run is still in progress.
 * @param command  The task command (already secret-redacted by the caller).
 * @param cron     The cron expression, if any, for context.
 */
export function formatOverlapAlertMessage(
  taskId: string,
  command: string,
  cron: string | undefined,
): string {
  const cronNote = cron !== undefined ? ` (cron: ${cron})` : '';
  return (
    `[daemon] Overlap detected for task "${taskId}"${cronNote}: ` +
    `the previous run is still in progress when the next tick fired.\n` +
    `Command: ${command}\n` +
    `Further overlap skips for this task are logged to telemetry without alerts ` +
    `until the current run completes.`
  );
}
