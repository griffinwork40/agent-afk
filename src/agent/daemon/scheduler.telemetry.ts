import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { errorMessage } from '../../utils/errors.js';
import { FailureStreakTracker, applyStreakLogic, isFailureStatus } from './scheduler.failure-streak.js';
import { dispatchCompletion, notificationDecision, type CompletionCallback } from './scheduler.notification.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

/**
 * Stamp the durable run before starting delivery; pull queue ids never retain streak state.
 * The callback still fires if the append fails. Exactly-once is not guaranteed
 * across a crash between append and delivery; missing settlement means unknown.
 */
export function writeRunTelemetry(
  path: string,
  tracker: FailureStreakTracker,
  callback: CompletionCallback | undefined,
  record: TelemetryRecord,
  task?: ScheduledTask,
  details?: TaskCompletionDetails,
): void {
  const run: TelemetryRecord = {
    ...record,
    runId: randomUUID(),
    ...(details?.doneUnverified === true ? { doneUnverified: true } : {}),
  };
  // executePullTick supplies a fresh queue id and propagates trigger:'pull'
  // through runOnce and executeAgentTask, including skipped/error run records.
  const recurring = record.trigger !== 'pull';
  if (recurring) tracker.hydrate(record.taskId, path);
  const { persistedRecord, effectiveTask, effectiveDetails } = recurring
    ? applyStreakLogic(tracker, task, run, details, callback !== undefined)
    : {
      persistedRecord: {
        ...run,
        notificationDecision: notificationDecision(
          run, task, callback !== undefined, isFailureStatus(run.status) ? 'failure' : 'completion',
        ),
      },
      effectiveTask: task,
      effectiveDetails: details,
    };
  try {
    appendFileSync(path, `${JSON.stringify(persistedRecord)}\n`, 'utf8');
  } catch (err) {
    console.error(`[daemon] telemetry write failed: ${errorMessage(err)}`);
  }
  dispatchCompletion(persistedRecord, callback, effectiveTask, effectiveDetails, path);
}
