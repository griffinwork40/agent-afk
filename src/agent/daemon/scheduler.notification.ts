import { appendFileSync } from 'node:fs';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import { errorMessage } from '../../utils/errors.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

/** Purpose of a notification decision, independent of whether delivery succeeds. */
export type NotificationKind = 'completion' | 'failure' | 'escalation' | 're-escalation' | 'recovery';

/** Policy decision stamped before delivery; due is not a delivery receipt. */
export interface NotificationDecision {
  state: 'due' | 'not-due' | 'suppressed';
  kind: NotificationKind;
  reason?: 'policy-never' | 'policy-failure' | 'no-callback';
}

/** Delivery result reported by the callback; missing results must remain unknown. */
export interface NotificationOutcome {
  target: string | number | readonly number[] | null;
  outcome: 'delivered' | 'failed' | 'unconfigured' | 'unknown';
}

/** Notify asynchronously or synchronously; returning void means unknown outcome, not success. */
export type CompletionCallback = (
  record: TelemetryRecord,
  details?: TaskCompletionDetails,
) => void | NotificationOutcome | Promise<void | NotificationOutcome>;

/** Append-only settlement receipt; readers must not count it as another task run. */
export interface NotificationDeliveryRecord extends NotificationOutcome {
  recordType: 'notification-delivery';
  runId?: string;
  taskId: string;
  triggeredAt: string;
  settledAt: string;
  kind: NotificationKind;
}

/** Resolve policy without invoking callbacks or claiming that a due notice was delivered. */
export function notificationDecision(
  record: TelemetryRecord,
  task: ScheduledTask | undefined,
  hasCallback: boolean,
  kind: NotificationKind = 'completion',
): NotificationDecision {
  if (task?.notifyOn === 'never') return { state: 'suppressed', kind, reason: 'policy-never' };
  if (task?.notifyOn === 'failure' && record.status !== 'error' && record.status !== 'blocked') {
    return { state: 'not-due', kind, reason: 'policy-failure' };
  }
  return {
    state: 'due',
    kind,
    ...(!hasCallback ? { reason: 'no-callback' as const } : {}),
  };
}

/**
 * Callback settlement never blocks the run append or escapes as a rejection.
 * Void callbacks and missing settlement after shutdown are unknown, not success.
 * Targets are resolved by the CLI layer, not by the scheduler.
 */
export function dispatchCompletion(
  record: TelemetryRecord,
  callback: CompletionCallback | undefined,
  task?: ScheduledTask,
  details?: TaskCompletionDetails,
  telemetryPath?: string,
): void {
  const decision = record.notificationDecision ?? notificationDecision(record, task, callback !== undefined);
  if (decision.state !== 'due' || callback === undefined) return;
  const effectiveDetails = task?.notifyChat !== undefined
    ? { ...details, notifyChat: details?.notifyChat ?? task.notifyChat }
    : details;
  const persist = (outcome: NotificationOutcome): void => {
    if (telemetryPath === undefined) return;
    const delivery: NotificationDeliveryRecord = {
      recordType: 'notification-delivery',
      runId: record.runId,
      taskId: record.taskId,
      triggeredAt: record.triggeredAt,
      settledAt: new Date().toISOString(),
      kind: decision.kind,
      ...outcome,
    };
    try {
      appendFileSync(telemetryPath, `${JSON.stringify(delivery)}\n`, 'utf8');
    } catch (err) {
      console.error(`[daemon] delivery telemetry write failed: ${errorMessage(err)}`);
    }
  };
  const failed = (err: unknown): void => {
    console.error(`[daemon] onTaskComplete callback failed: ${redactInlineSecrets(errorMessage(err))}`);
    persist({ target: effectiveDetails?.notifyChat ?? null, outcome: 'failed' });
  };
  try {
    const result = callback(record, effectiveDetails);
    void Promise.resolve(result).then(
      (outcome) => persist(outcome ?? { target: effectiveDetails?.notifyChat ?? null, outcome: 'unknown' }),
      failed,
    );
  } catch (err) {
    failed(err);
  }
}
