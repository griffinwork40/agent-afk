/**
 * Consecutive-failure streak tracker for the daemon scheduler.
 *
 * Tracks per-task run outcomes in memory and fires:
 *   - ONE escalation alert when a task reaches its failure-streak threshold
 *     (default 3 consecutive failures).  Subsequent failures in the same
 *     streak are silent so a daily notice from a noisy channel is not repeated
 *     indefinitely.
 *   - ONE "recovered" alert when the task next succeeds after the threshold
 *     was breached.
 *
 * "Failed" means `status === 'error' || status === 'blocked'` — matching the
 * issue's definition.  `status === 'skipped'` does NOT count toward the streak
 * (a budget-gate skip or overlap skip is not an execution failure).
 *
 * Invariant: daemon-process state only.  A daemon restart resets all counters,
 * which is acceptable and preferable to adding more I/O to the hot path; the
 * streak will re-escalate within `threshold` more failures after restart.
 *
 * Modelled after `OverlapAlertLatch` and `BudgetAlertLatch`.
 *
 * @module agent/daemon/scheduler.failure-streak
 */

import { redactInlineSecrets } from '../session/prompt-dump.js';
import type { TelemetryRecord, TelemetryTrigger, TaskCompletionDetails } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default consecutive-failure count that triggers an escalation alert. */
export const DEFAULT_FAILURE_STREAK_THRESHOLD = 3;

/** Re-escalation interval: after the initial alert, re-alert every N failures. */
export const REESCALATION_INTERVAL = 10;

// ─── Per-task streak state ────────────────────────────────────────────────────

interface StreakState {
  /** Current consecutive-failure count. */
  count: number;
  /** ISO timestamp of the first failure in the current streak. */
  failingSince: string;
  /** True once the threshold alert has been sent for this streak episode. */
  escalated: boolean;
  /** Number of additional failures since the initial escalation. */
  extraFailures: number;
  /** Redacted last error line from the most recent failure. */
  lastError: string | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether a telemetry record counts as a "failure" for streak purposes.
 * Both `error` and `blocked` count; `skipped` and `success` do not.
 */
export function isFailureStatus(status: TelemetryRecord['status']): boolean {
  return status === 'error' || status === 'blocked';
}

/**
 * Plain-text escalation message for the first alert of a streak episode.
 */
export function formatStreakEscalation(
  taskId: string,
  taskName: string | undefined,
  count: number,
  failingSince: string,
  lastError: string | undefined,
  cron: string | undefined,
): string {
  const label = taskName !== undefined ? `"${taskName}" (${taskId})` : `"${taskId}"`;
  const cronNote = cron !== undefined ? ` (cron: ${cron})` : '';
  const errorNote = lastError !== undefined ? `\nLast error: ${lastError}` : '';
  return (
    `[daemon] Task ${label}${cronNote} has failed ${count} runs in a row.\n` +
    `Failing since: ${failingSince}${errorNote}\n` +
    `Further failures for this task are logged to telemetry without alerts ` +
    `until it recovers or reaches the re-escalation interval.`
  );
}

/**
 * Plain-text re-escalation message for continued failures after the initial alert.
 */
export function formatStreakReEscalation(
  taskId: string,
  taskName: string | undefined,
  count: number,
  failingSince: string,
  lastError: string | undefined,
  cron: string | undefined,
): string {
  const label = taskName !== undefined ? `"${taskName}" (${taskId})` : `"${taskId}"`;
  const cronNote = cron !== undefined ? ` (cron: ${cron})` : '';
  const errorNote = lastError !== undefined ? `\nLast error: ${lastError}` : '';
  return (
    `[daemon] Task ${label}${cronNote} is STILL failing — ${count} consecutive failures.\n` +
    `Failing since: ${failingSince}${errorNote}`
  );
}

/**
 * Plain-text recovery message sent after a streak is cleared by a success.
 */
export function formatStreakRecovery(
  taskId: string,
  taskName: string | undefined,
  streakCount: number,
  failingSince: string,
  cron: string | undefined,
): string {
  const label = taskName !== undefined ? `"${taskName}" (${taskId})` : `"${taskId}"`;
  const cronNote = cron !== undefined ? ` (cron: ${cron})` : '';
  return (
    `[daemon] Task ${label}${cronNote} has recovered after ${streakCount} consecutive failure(s).\n` +
    `Was failing since: ${failingSince}`
  );
}

// ─── Main tracker class ───────────────────────────────────────────────────────

/**
 * Per-daemon-process failure-streak tracker.
 *
 * Call `record()` after every task completion.  It returns the notification
 * action to take — `'escalate'`, `'re-escalate'`, `'recover'`, or `'none'`
 * — together with the message text.  The scheduler wires this into
 * `writeTelemetry` to override `notifyOn` exactly once per streak/recovery
 * event, then threads the text as `details.responseText`.
 */
export class FailureStreakTracker {
  private readonly streaks = new Map<string, StreakState>();

  /**
   * Process a completed run record.
   *
   * Returns the notification action and message for this run:
   *   - `'none'`        — no streak action needed.
   *   - `'escalate'`    — first alert for a new streak above threshold.
   *   - `'re-escalate'` — reminder for an ongoing streak every REESCALATION_INTERVAL.
   *   - `'recover'`     — streak cleared by a success (threshold was previously breached).
   *
   * @param taskId     Stable task identifier.
   * @param task       ScheduledTask (for label, cron) — may be undefined for synthetic tasks.
   * @param record     The telemetry record just produced.
   * @param threshold  Failure count that triggers escalation (default: DEFAULT_FAILURE_STREAK_THRESHOLD).
   */
  record(
    taskId: string,
    task: ScheduledTask | undefined,
    record: TelemetryRecord,
    threshold: number = DEFAULT_FAILURE_STREAK_THRESHOLD,
  ): StreakAction {
    const isFailure = isFailureStatus(record.status);

    if (!isFailure) {
      // Skipped runs (overlap, budget-over, telemetry-unwritable, etc.) neither
      // increment nor reset the streak — they are not genuine execution outcomes.
      if (record.status === 'skipped') return { action: 'none' };

      // Success: clears streak. Sends recovery if threshold was previously breached.
      const existing = this.streaks.get(taskId);
      if (existing !== undefined && existing.escalated) {
        const { count, failingSince } = existing;
        this.streaks.delete(taskId);
        const msg = formatStreakRecovery(
          taskId, task?.name, count, failingSince, task?.cronExpression,
        );
        return { action: 'recover', message: msg };
      }
      // Clear streak even if it hadn't escalated yet.
      if (existing !== undefined) this.streaks.delete(taskId);
      return { action: 'none' };
    }

    // Failure: increment or start streak.
    const existing = this.streaks.get(taskId);
    const redactedError = record.errorMessage !== undefined
      ? redactInlineSecrets(record.errorMessage).slice(0, 200)
      : undefined;

    if (existing === undefined) {
      // First failure — start a new streak.
      const state: StreakState = {
        count: 1,
        failingSince: record.triggeredAt,
        escalated: false,
        extraFailures: 0,
        lastError: redactedError,
      };
      this.streaks.set(taskId, state);
      // Check threshold immediately (threshold === 1 means alert on first failure).
      if (state.count >= threshold) {
        state.escalated = true;
        const msg = formatStreakEscalation(
          taskId, task?.name, state.count, state.failingSince, state.lastError, task?.cronExpression,
        );
        return { action: 'escalate', message: msg };
      }
      return { action: 'none' };
    }

    // Existing streak — increment.
    existing.count += 1;
    existing.lastError = redactedError;

    if (!existing.escalated) {
      if (existing.count >= threshold) {
        existing.escalated = true;
        const msg = formatStreakEscalation(
          taskId, task?.name, existing.count, existing.failingSince, existing.lastError, task?.cronExpression,
        );
        return { action: 'escalate', message: msg };
      }
      return { action: 'none' };
    }

    // Already escalated — check for re-escalation.
    existing.extraFailures += 1;
    if (existing.extraFailures % REESCALATION_INTERVAL === 0) {
      const msg = formatStreakReEscalation(
        taskId, task?.name, existing.count, existing.failingSince, existing.lastError, task?.cronExpression,
      );
      return { action: 're-escalate', message: msg };
    }
    return { action: 'none' };
  }

  /**
   * Return the current streak state for a task, or `undefined` when there is
   * no active streak.  Used by `afk schedule health` and `schedule list`.
   */
  getStreak(taskId: string): Readonly<StreakState> | undefined {
    return this.streaks.get(taskId);
  }

  /**
   * Enumerate all tasks currently in an active streak at or above `threshold`.
   * Returns entries in insertion order (oldest streak first).
   */
  listBreachedStreaks(threshold: number = DEFAULT_FAILURE_STREAK_THRESHOLD): Array<{
    taskId: string;
    count: number;
    failingSince: string;
    lastError: string | undefined;
  }> {
    const result: Array<{ taskId: string; count: number; failingSince: string; lastError: string | undefined }> = [];
    for (const [taskId, state] of this.streaks) {
      if (state.count >= threshold) {
        result.push({ taskId, count: state.count, failingSince: state.failingSince, lastError: state.lastError });
      }
    }
    return result;
  }

  /** Exposed for tests: reset all streak state. */
  _reset(): void {
    this.streaks.clear();
  }
}

// ─── Action type ─────────────────────────────────────────────────────────────

export type StreakActionKind = 'none' | 'escalate' | 're-escalate' | 'recover';

export interface StreakAction {
  action: StreakActionKind;
  /** Formatted message text; absent when action is 'none'. */
  message?: string;
}

// ─── Telemetry helpers ────────────────────────────────────────────────────────

/**
 * Build a streak-escalation telemetry record for a failed run that just
 * tripped the threshold. The record is identical to the original run record
 * except it carries a `notifySent` marker so the telemetry history shows
 * whether (and what kind of) notification was sent.
 */
export function withNotifySent(
  record: TelemetryRecord,
  kind: 'escalation' | 're-escalation' | 'recovery' | 'failure',
): TelemetryRecord {
  return { ...record, notifySent: kind };
}

// ─── TelemetryRecord extension ────────────────────────────────────────────────
// (Declaration merging via augmentation is not used; we extend the core type
// directly because TelemetryRecord is defined in scheduler.ts. The field is
// added there as an optional field so the import chain stays clean.)
//
// This module re-exports the helper only. The field is declared in scheduler.ts.

/**
 * Compute the per-task failure-streak threshold.
 *
 * Order of precedence:
 *   1. `task.failureStreakThreshold` (per-task override)
 *   2. `DEFAULT_FAILURE_STREAK_THRESHOLD` (3)
 */
export function resolveThreshold(task: ScheduledTask | undefined): number {
  if (task !== undefined && typeof task.failureStreakThreshold === 'number') {
    return Math.max(1, task.failureStreakThreshold);
  }
  return DEFAULT_FAILURE_STREAK_THRESHOLD;
}

// ─── Health snapshot ──────────────────────────────────────────────────────────

/** A single row in the `afk schedule health` output. */
export interface HealthRow {
  taskId: string;
  taskName: string | undefined;
  streakCount: number;
  failingSince: string;
  lastError: string | undefined;
  threshold: number;
}

/**
 * Build the health snapshot: tasks whose current streak meets or exceeds their
 * configured threshold.  Returns an empty array when all tasks are healthy.
 *
 * @param tracker    The scheduler's shared FailureStreakTracker instance.
 * @param tasks      Registered tasks (used to look up per-task thresholds and names).
 * @param threshold  Default threshold (overridden per-task by failureStreakThreshold).
 */
export function buildHealthSnapshot(
  tracker: FailureStreakTracker,
  tasks: readonly ScheduledTask[],
  threshold: number = DEFAULT_FAILURE_STREAK_THRESHOLD,
): HealthRow[] {
  const taskMap = new Map<string, ScheduledTask>(tasks.map((t) => [t.taskId, t]));
  const rows: HealthRow[] = [];
  const breached = tracker.listBreachedStreaks(1); // get all, filter by per-task threshold below
  for (const { taskId, count, failingSince, lastError } of breached) {
    const task = taskMap.get(taskId);
    const effectiveThreshold = resolveThreshold(task) ?? threshold;
    if (count >= effectiveThreshold) {
      rows.push({
        taskId,
        taskName: task?.name,
        streakCount: count,
        failingSince,
        lastError,
        threshold: effectiveThreshold,
      });
    }
  }
  return rows;
}

/**
 * Fake trigger value used only as a placeholder when constructing synthetic
 * telemetry records (e.g. for the streak-recovery notification path). The
 * real trigger is always taken from the original run record.
 */
export const STREAK_PLACEHOLDER_TRIGGER: TelemetryTrigger = 'cron';

// ─── writeTelemetry streak integration ───────────────────────────────────────

/**
 * Result of applying streak logic to a telemetry record.
 *
 * Returned by {@link applyStreakLogic} and consumed by
 * `CronScheduler.writeTelemetry` to decide:
 *   - which record to persist (may carry `notifySent` / `failingSince`),
 *   - which task shape to pass to `fireOnTaskComplete` (may override notifyOn),
 *   - which details to pass (may carry the alert text as `responseText`).
 */
export interface StreakApplicationResult {
  persistedRecord: TelemetryRecord;
  effectiveTask: ScheduledTask | undefined;
  effectiveDetails: TaskCompletionDetails | undefined;
}

/**
 * Apply failure-streak logic to one telemetry record inside `writeTelemetry`.
 *
 * Extracted from `CronScheduler.writeTelemetry` so the scheduler stays within
 * the 350-code-line ceiling (#5146).  Behaviour is identical to the inline
 * version; the only change is that `tracker`, `task`, `record`, `details`, and
 * `hasCallback` are now explicit parameters rather than captured from the class.
 *
 * @param tracker      The scheduler's shared `FailureStreakTracker`.
 * @param task         The `ScheduledTask` for this run (may be undefined for
 *                     synthetic pull tasks).
 * @param record       The telemetry record as constructed before this call.
 * @param details      Existing `TaskCompletionDetails` (may be undefined).
 * @param hasCallback  True when `SchedulerOptions.onTaskComplete` is defined.
 */
export function applyStreakLogic(
  tracker: FailureStreakTracker,
  task: ScheduledTask | undefined,
  record: TelemetryRecord,
  details: TaskCompletionDetails | undefined,
  hasCallback: boolean,
): StreakApplicationResult {
  // Skipped runs never count toward the streak.
  if (record.status === 'skipped' || task === undefined) {
    return { persistedRecord: record, effectiveTask: task, effectiveDetails: details };
  }

  const threshold = resolveThreshold(task);
  const streakAction = tracker.record(task.taskId, task, record, threshold);

  let persistedRecord = record;

  // Annotate failingSince onto runs that are part of an active streak (count >= 2).
  const streakState = tracker.getStreak(task.taskId);
  if (streakState !== undefined && streakState.count >= 2) {
    persistedRecord = { ...persistedRecord, failingSince: streakState.failingSince };
  }

  if (streakAction.action !== 'none' && streakAction.message !== undefined) {
    // Streak event: override notifyOn to 'always' so the alert fires regardless
    // of the task's normal notification policy, and thread the formatted message
    // as responseText so the push formatter can render it.
    const effectiveTask: ScheduledTask = { ...task, notifyOn: 'always' as const };
    const effectiveDetails: TaskCompletionDetails = {
      ...(details ?? {}),
      responseText: streakAction.message,
    };
    const sentKind: TelemetryRecord['notifySent'] =
      streakAction.action === 'escalate' ? 'escalation'
      : streakAction.action === 're-escalate' ? 're-escalation'
      : 'recovery';
    persistedRecord = withNotifySent(persistedRecord, sentKind);
    return { persistedRecord, effectiveTask, effectiveDetails };
  }

  // No streak event. Record whether the per-run notification will fire.
  if (task.notifyOn !== undefined && hasCallback) {
    const wouldNotify = task.notifyOn !== 'never'
      && (task.notifyOn === 'always' || record.status === 'error' || record.status === 'blocked');
    persistedRecord = wouldNotify
      ? withNotifySent(persistedRecord, 'failure')
      : { ...persistedRecord, notifySent: 'none' as const };
  }
  return { persistedRecord, effectiveTask: task, effectiveDetails: details };
}


