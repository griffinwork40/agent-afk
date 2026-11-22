// Consecutive failures retain ordinary per-failure notices. Streak events add
// one escalation, periodic re-escalation, and one recovery decision per episode.
// Snapshots survive restart; exactly-once is not guaranteed across a crash
// between append and delivery. Delivery is a separate, asynchronous fact.
import { redactInlineSecrets } from '../session/prompt-dump.js';
import { errorMessage } from '../../utils/errors.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';
import { emptyStreak, readStreakHistory, type StreakSnapshot } from './scheduler.streak-history.js';
import { notificationDecision } from './scheduler.notification.js';
import { getSchedule } from './schedule-store.js';

/** Default consecutive failures before the first escalation decision. */
export const DEFAULT_FAILURE_STREAK_THRESHOLD = 3;

/** Further failures between reminder decisions after the first escalation. */
export const REESCALATION_INTERVAL = 10;

/** Execution errors advance the streak; so do legacy `'blocked'` rows read from old telemetry. */
export function isFailureStatus(status: TelemetryRecord['status']): boolean {
  return status === 'error' || status === 'blocked';
}

function label(taskId: string, taskName: string | undefined, cron: string | undefined): string {
  const name = taskName !== undefined ? `"${taskName}" (${taskId})` : `"${taskId}"`;
  return `${name}${cron !== undefined ? ` (cron: ${cron})` : ''}`;
}

/** Describe the initial escalation without promising notification delivery or silence. */
export function formatStreakEscalation(
  taskId: string,
  taskName: string | undefined,
  count: number,
  failingSince: string,
  lastError: string | undefined,
  cron: string | undefined,
): string {
  return `[daemon] Task ${label(taskId, taskName, cron)} has failed ${count} runs in a row.\n`
    + `Failing since: ${failingSince}${lastError !== undefined ? `\nLast error: ${lastError}` : ''}\n`
    + 'Ordinary failure notices continue according to the task notification policy; streak reminders are periodic.';
}

/** Describe a periodic reminder that an escalated streak is still failing. */
export function formatStreakReEscalation(
  taskId: string,
  taskName: string | undefined,
  count: number,
  failingSince: string,
  lastError: string | undefined,
  cron: string | undefined,
): string {
  return `[daemon] Task ${label(taskId, taskName, cron)} is STILL failing — ${count} consecutive failures.\n`
    + `Failing since: ${failingSince}${lastError !== undefined ? `\nLast error: ${lastError}` : ''}`;
}

/** Describe recovery from a previously escalated streak. */
export function formatStreakRecovery(
  taskId: string,
  taskName: string | undefined,
  streakCount: number,
  failingSince: string,
  cron: string | undefined,
): string {
  return `[daemon] Task ${label(taskId, taskName, cron)} has recovered after ${streakCount} consecutive failure(s).\n`
    + `Was failing since: ${failingSince}`;
}

/** Transition chosen for this run, independent of notification policy or delivery. */
export type StreakActionKind = 'none' | 'escalate' | 're-escalate' | 'recover';

/** A streak transition and optional replacement notification text. */
export interface StreakAction {
  action: StreakActionKind;
  message?: string;
}

/** Cached recurring-task state; callers must forget unregistered tasks and exclude synthetic runs. */
export class FailureStreakTracker {
  private readonly streaks = new Map<string, StreakSnapshot>();
  private readonly hydrated = new Set<string>();

  /** Load bounded durable history once per recurring task, including empty history. */
  hydrate(taskId: string, telemetryPath: string): void {
    if (this.hydrated.has(taskId)) return;
    this.hydrated.add(taskId);
    // ScheduledTask omits createdAt; one store lookup avoids widening registration/HTTP shapes.
    let createdAt: string | undefined;
    try {
      createdAt = getSchedule(taskId)?.createdAt;
    } catch (err) {
      console.error(`[daemon] streak hydration: schedule-store read failed for task "${taskId}": ${errorMessage(err)}`);
    }
    this.streaks.set(taskId, readStreakHistory(telemetryPath, taskId, createdAt).snapshot);
  }

  /** Release both cached history and streak state when a task is unregistered. */
  forget(taskId: string): void {
    this.streaks.delete(taskId);
    this.hydrated.delete(taskId);
  }

  /** Advance a recurring task's streak; skips preserve it and success resets it. */
  record(
    taskId: string,
    task: ScheduledTask | undefined,
    record: TelemetryRecord,
    threshold: number = DEFAULT_FAILURE_STREAK_THRESHOLD,
  ): StreakAction {
    const state = this.streaks.get(taskId) ?? emptyStreak();
    this.streaks.set(taskId, state);
    if (record.status === 'skipped') return { action: 'none' };
    if (!isFailureStatus(record.status)) {
      this.streaks.set(taskId, emptyStreak());
      return state.escalated
        ? {
          action: 'recover',
          message: formatStreakRecovery(
            taskId, task?.name, state.count, state.failingSince ?? '', task?.cronExpression,
          ),
        }
        : { action: 'none' };
    }
    state.count++;
    state.failingSince ??= record.triggeredAt;
    const rawError = record.errorMessage ?? record.responseExcerpt;
    if (rawError !== undefined) {
      const lastLine = rawError.trimEnd().split('\n').filter((l) => l.trim() !== '').at(-1) ?? rawError;
      state.lastError = redactInlineSecrets(lastLine).slice(0, 200);
    } else {
      state.lastError = undefined;
    }
    if (!state.escalated && state.count >= threshold) {
      state.escalated = true;
      return {
        action: 'escalate',
        message: formatStreakEscalation(
          taskId, task?.name, state.count, state.failingSince, state.lastError, task?.cronExpression,
        ),
      };
    }
    if (state.escalated && ++state.extraFailures % REESCALATION_INTERVAL === 0) {
      return {
        action: 're-escalate',
        message: formatStreakReEscalation(
          taskId, task?.name, state.count, state.failingSince, state.lastError, task?.cronExpression,
        ),
      };
    }
    return { action: 'none' };
  }

  /** Inspect a live failure streak, or undefined for an empty/unknown task. */
  getStreak(taskId: string): Readonly<StreakSnapshot> | undefined {
    const state = this.streaks.get(taskId);
    return state?.count ? state : undefined;
  }

  /** Return a detached snapshot suitable for stamping on a run row. */
  snapshot(taskId: string): StreakSnapshot {
    return { ...(this.streaks.get(taskId) ?? emptyStreak()) };
  }

  /** List cached streaks meeting a threshold, without treating decisions as deliveries. */
  listBreachedStreaks(threshold = DEFAULT_FAILURE_STREAK_THRESHOLD): Array<{
    taskId: string;
    count: number;
    failingSince: string;
    lastError: string | undefined;
  }> {
    return [...this.streaks]
      .filter(([, s]) => s.count >= threshold)
      .map(([taskId, s]) => ({
        taskId,
        count: s.count,
        failingSince: s.failingSince ?? '',
        lastError: s.lastError,
      }));
  }

  /** Clear all process-local state for tests. */
  _reset(): void {
    this.streaks.clear();
    this.hydrated.clear();
  }
}

/** Resolve a recurring task's configured threshold, falling back to the daemon default. */
export function resolveThreshold(task: ScheduledTask | undefined): number {
  return Math.max(1, task?.failureStreakThreshold ?? DEFAULT_FAILURE_STREAK_THRESHOLD);
}

/** Durable run plus notification inputs; a decision does not imply delivery. */
export interface StreakApplicationResult {
  persistedRecord: TelemetryRecord;
  effectiveTask: ScheduledTask | undefined;
  effectiveDetails: TaskCompletionDetails | undefined;
}

/** Apply recurring-task streak transitions and stamp the notification decision. */
export function applyStreakLogic(
  tracker: FailureStreakTracker,
  task: ScheduledTask | undefined,
  record: TelemetryRecord,
  details: TaskCompletionDetails | undefined,
  hasCallback: boolean,
): StreakApplicationResult {
  const action = tracker.record(record.taskId, task, record, resolveThreshold(task));
  const failureStreak = tracker.snapshot(record.taskId);
  const effectiveTask = action.action !== 'none' && task !== undefined && task.notifyOn !== 'never'
    ? { ...task, notifyOn: 'always' as const }
    : task;
  let effectiveDetails = details;
  if (action.message !== undefined) {
    effectiveDetails = { ...details, responseText: action.message };
  } else if (isFailureStatus(record.status) && failureStreak.escalated) {
    const diagnostic = details?.responseText ?? record.responseExcerpt ?? record.errorMessage ?? '';
    effectiveDetails = {
      ...details,
      responseText: `Failure ${failureStreak.count} in a row, failing since ${failureStreak.failingSince}.\n`
        + diagnostic,
    };
  }
  const kind = action.action === 'escalate' ? 'escalation'
    : action.action === 're-escalate' ? 're-escalation'
    : action.action === 'recover' ? 'recovery'
    : isFailureStatus(record.status) ? 'failure' : 'completion';
  if (action.action !== 'none') {
    console.error(
      `[daemon] streak ${action.action}: task "${record.taskId}" count=${failureStreak.count}${failureStreak.failingSince !== undefined ? ` failingSince=${failureStreak.failingSince}` : ''}`,
    );
  }
  return {
    persistedRecord: {
      ...record,
      failureStreak,
      ...(failureStreak.failingSince !== undefined ? { failingSince: failureStreak.failingSince } : {}),
      notificationDecision: notificationDecision(record, effectiveTask, hasCallback, kind),
    },
    effectiveTask,
    effectiveDetails,
  };
}
