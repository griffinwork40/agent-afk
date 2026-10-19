/**
 * Startup task registration with quarantine for invalid tasks.
 *
 * Extracted from `startDaemon` (daemon.ts) to keep that file under the
 * 350-code-line ceiling.
 *
 * @module agent/daemon.startup-register
 */

import { errorMessage } from '../utils/errors.js';
import type { CronScheduler } from './daemon/scheduler.js';
import type { ScheduledTask } from './daemon/triggers.js';

/**
 * Register each task with the scheduler, quarantining any that fail
 * validation (e.g. a hand-edited `schedules.json` with a malformed
 * `runAt`/`expiresAt`). Invalid tasks are skipped with a `console.warn`
 * so the daemon starts rather than crashing, and valid tasks remain
 * fully operational.
 *
 * `scheduler.register()` calls `validateScheduledTask()`, which throws on
 * an invalid ISO 8601 date string. Unlike the post-startup `'malformed'` gate
 * path in `evaluateRunAtGate` (scheduler.runat-gate.ts), startup quarantine
 * only emits a `console.warn` — it does NOT write a `status:'skipped'`
 * telemetry record, because the scheduler tick loop has not started yet.
 * (#4052)
 */
export function registerTasksWithQuarantine(
  scheduler: CronScheduler,
  tasks: ScheduledTask[],
): void {
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
    }
  }
}
