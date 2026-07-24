/**
 * Daemon trigger types.
 *
 * Phase 5 wired `cron`; Phase 6 adds `sessionstart` and `both`;
 * Phase 7 adds `pull` (queue-driven, polling-based dequeue).
 *   - `cron`: node-cron schedule.
 *   - `sessionstart`: fire once when the daemon process starts, gated by
 *     cooldown (last-fire timestamp in telemetry) and brief-queue (skip if
 *     any pending briefs in `~/.afk/agent-framework/briefs/`).
 *   - `both`: register a cron schedule AND fire on daemon startup.
 *   - `pull`: dequeue tasks from the file-based queue directory on a polling
 *     interval. Use `afk queue add <command>` to enqueue tasks. The daemon
 *     runs one queued task per poll tick when idle. No cronExpression needed.
 *
 * @module agent/daemon/triggers
 */

export type TriggerMode = 'cron' | 'sessionstart' | 'both' | 'pull';

export interface ScheduledTask {
  /** Stable identifier; stops/restarts target this. */
  taskId: string;
  /** Command sent as a user message into the spawned session (e.g. `/forge-friction --auto`). */
  command: string;
  /** Trigger mode. */
  trigger: TriggerMode;
  /** Cron expression (5- or 6-field). Required when trigger includes `'cron'`. */
  cronExpression?: string;
  /**
   * Per-task cooldown override for sessionstart fires. Falls back to the
   * scheduler's default (6h) when omitted.
   */
  debounceMs?: number;
  /**
   * Controls when out-of-band notifications fire for this task.
   * 'always'  — notify on every completion (success, error, or skipped)
   * 'failure' — notify only when status === 'error'
   * 'never'   — never notify (silences onTaskComplete callback)
   * Omitting this field preserves existing behavior (callback always fires).
   */
  notifyOn?: 'failure' | 'always' | 'never';
  /**
   * Optional explicit chat target for this task's completion notification.
   * A number is a raw Telegram chat id; a string is either a numeric id or a
   * name looked up in afk.config.json `telegram.chatAliases`. When set (and
   * allowlisted), the daemon delivers this task's completion push to THIS chat
   * instead of the configured default notify target. When omitted, routing is
   * unchanged (resolveConfiguredNotifyTargets). The resolved chat must be in the
   * inbound allowlist or the override is refused and delivery falls back to the
   * default — see the daemon `onTaskComplete` wiring in
   * `src/cli/commands/daemon.ts`. Independent of `notifyOn` (which only decides
   * WHETHER to notify; this decides WHERE).
   */
  notifyChat?: number | string;
}

/**
 * Validate a task before registering it. Throws on misconfiguration so the
 * scheduler doesn't silently drop tasks.
 */
export function validateScheduledTask(task: ScheduledTask): void {
  if (!task.taskId) throw new Error('ScheduledTask.taskId is required');
  if (!task.command) throw new Error(`task ${task.taskId}: command is required`);
  if (task.trigger === 'cron' || task.trigger === 'both') {
    if (!task.cronExpression) {
      throw new Error(`task ${task.taskId}: cronExpression required for trigger=${task.trigger}`);
    }
  }
  if (task.trigger === 'pull' && task.cronExpression !== undefined) {
    throw new Error(
      `task ${task.taskId}: cronExpression must not be set when trigger='pull' — pull tasks are dequeued from the queue directory, not scheduled via cron`,
    );
  }
}
