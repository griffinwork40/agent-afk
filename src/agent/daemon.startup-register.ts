/**
 * Startup task registration with quarantine for invalid tasks.
 *
 * Extracted from `startDaemon` (daemon.ts) to keep that file under the
 * 350-code-line ceiling.
 *
 * @module agent/daemon.startup-register
 */

import { appendFileSync } from 'node:fs';
import { errorMessage } from '../utils/errors.js';
import { getTelemetryPath } from '../paths.js';
import type { CronScheduler, TelemetryRecord } from './daemon/scheduler.js';
import type { ScheduledTask } from './daemon/triggers.js';

/**
 * Register each task with the scheduler, quarantining any that fail
 * validation (e.g. a hand-edited `schedules.json` with a malformed
 * `runAt`/`expiresAt`). Invalid tasks are skipped with a `console.warn`
 * so the daemon starts rather than crashing, and valid tasks remain
 * fully operational.
 *
 * `scheduler.register()` calls `validateScheduledTask()`, which throws on
 * an invalid ISO 8601 date string. A `status:'skipped' skipReason:'malformed'`
 * telemetry record is written for each quarantined task, matching the
 * post-startup malformed-gate path in `evaluateRunAtGate`
 * (scheduler.runat-gate.ts). (#4502)
 */
export function registerTasksWithQuarantine(
  scheduler: CronScheduler,
  tasks: ScheduledTask[],
  options: { telemetryPath?: string } = {},
): void {
  const resolvedTelemetryPath = options.telemetryPath ?? getTelemetryPath();

  for (const task of tasks) {
    try {
      scheduler.register(task);
    } catch (err) {
      // Intentionally quarantines ANY register() error, not only date validation.
      // eslint-disable-next-line no-console
      console.warn(
        `[daemon] skipping task ${task.taskId} at startup: ${errorMessage(err)}. ` +
          'Fix schedules.json to restore normal behaviour.',
      );

      // Emit a telemetry record so the quarantine is observable in the
      // forge-telemetry.jsonl log — mirrors the post-startup malformed path.
      const record: TelemetryRecord = {
        taskId: task.taskId,
        command: task.command,
        trigger: 'cron',
        ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
        triggeredAt: new Date().toISOString(),
        durationMs: 0,
        status: 'skipped',
        skipReason: 'malformed',
        errorMessage: `Task ${task.taskId} quarantined at startup: ${errorMessage(err)}`,
      };

      try {
        appendFileSync(resolvedTelemetryPath, `${JSON.stringify(record)}\n`, 'utf-8');
      } catch {
        // Best-effort: a telemetry write failure must never crash the daemon.
      }
    }
  }
}
