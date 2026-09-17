/**
 * Builtin task dispatcher for daemon scheduled tasks.
 *
 * Routes `executor: 'builtin'` tasks by their `command` field (the builtin
 * name) to the appropriate handler. Replaces the former magic-string
 * sentinel (`__BUILTIN_WORKTREE_PRUNE__`) with a typed dispatch table.
 *
 * @module agent/daemon/builtin-task
 */

import { runBuiltinWorktreePruneTask } from './worktree-prune-task.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';

export interface BuiltinTaskOptions {
  now: () => number;
  telemetryPath: () => string;
  writeTelemetry: (record: TelemetryRecord) => void;
}

/**
 * Dispatch a builtin task by name. The `command` field carries the builtin
 * name (e.g. `'worktree-prune'`). Also handles the legacy
 * `__BUILTIN_WORKTREE_PRUNE__` sentinel for backward compatibility.
 */
export async function runBuiltinTask(
  task: { taskId: string; command: string; cronExpression?: string },
  trigger: TelemetryTrigger,
  options: BuiltinTaskOptions,
): Promise<TelemetryRecord> {
  // Normalize: legacy sentinel -> builtin name
  const builtinName = task.command === '__BUILTIN_WORKTREE_PRUNE__'
    ? 'worktree-prune'
    : task.command;

  if (builtinName === 'worktree-prune') {
    return runBuiltinWorktreePruneTask(task, trigger, options);
  }

  // Unknown builtin -- should not happen if validateScheduledTask caught it
  const record: TelemetryRecord = {
    taskId: task.taskId,
    command: task.command,
    trigger,
    triggeredAt: new Date(options.now()).toISOString(),
    durationMs: 0,
    status: 'error',
    errorMessage: `unknown builtin: ${task.command}`,
  };
  options.writeTelemetry(record);
  return record;
}
