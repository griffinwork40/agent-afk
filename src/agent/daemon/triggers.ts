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

import {
  TASK_MAX_ATTEMPTS_LIMIT,
  TASK_RETRY_DELAY_MIN_MS,
  TASK_RETRY_DELAY_MAX_MS,
} from './task-retry.js';

export type TriggerMode = 'cron' | 'sessionstart' | 'both' | 'pull';

/**
 * Executor discriminant for scheduled tasks.
 *
 * - `'agent'` (default): spawn an AgentSession and send `command` as a user message.
 * - `'shell'`: run `command` as a shell command via execFile('/bin/sh', ['-c', command]).
 *   No agent session, no MCP, no hooks -- just shell exec + telemetry.
 * - `'builtin'`: dispatch to an internally-registered builtin handler keyed by `command`
 *   (e.g. `'worktree-prune'`). Replaces the former `__BUILTIN_WORKTREE_PRUNE__` sentinel.
 */
export type TaskExecutor = 'agent' | 'shell' | 'builtin';

/** Known builtin task names that `executor: 'builtin'` can dispatch to. */
const KNOWN_BUILTINS = ['worktree-prune', 'tool-health'] as const;
type BuiltinTaskName = (typeof KNOWN_BUILTINS)[number];

export interface ScheduledTask {
  /** Stable identifier; stops/restarts target this. */
  taskId: string;
  /**
   * Meaning depends on `executor`:
   * - `'agent'` (default): prompt sent as a user message into the spawned session.
   * - `'shell'`: shell command run via `/bin/sh -c`.
   * - `'builtin'`: the registered builtin name (e.g. `'worktree-prune'`).
   */
  command: string;
  /**
   * Execution strategy. Default: `'agent'` (spawn an AgentSession).
   * See {@link TaskExecutor} for the full set.
   */
  executor?: TaskExecutor;
  /** Trigger mode. */
  trigger: TriggerMode;
  /** Cron expression (5-field only — no year). Required when trigger includes `'cron'`. */
  cronExpression?: string;
  /**
   * One-shot fire time (ISO 8601). When set the task fires once at or after
   * this instant and is then automatically disabled. Mutually exclusive with
   * a recurring `cronExpression` — use one or the other, not both.
   * The scheduler checks `runAt` on every cron tick so the precision is
   * bounded by the cron interval; sub-minute precision is not guaranteed.
   */
  runAt?: string;
  /**
   * Hard expiry (ISO 8601). When set and the current time is past this
   * instant, the scheduler skips the task and records a
   * `status:'skipped', skipReason:'expired'` telemetry entry. The task is
   * also automatically disabled in the store so it never fires again.
   * Works with both recurring cron tasks and `runAt` one-shots.
   */
  expiresAt?: string;
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
  /**
   * Per-task working directory (absolute path). When set, the spawned session's
   * cwd is pinned to this directory instead of the daemon-wide `AFK_DAEMON_CWD`.
   * Precedence: task.cwd ?? AFK_DAEMON_CWD ?? daemonDefaultCwd().
   * Shell tasks honor this too: execFile receives it as the `cwd` option.
   */
  cwd?: string;
  /**
   * Total attempts per run (including the first) for `executor: 'agent'`
   * tasks. Default 1 = no retry. When > 1, a run that fails with a
   * classified-transient error (429, network blip, provider 5xx) is retried
   * in-process with exponential backoff while still holding the overlap
   * guard. Non-transient failures never retry. Bounds are enforced at the
   * input surfaces — see `parseTaskRetryFields` in `./task-retry.ts`.
   */
  maxAttempts?: number;
  /** Backoff base (ms) between retry attempts; doubles per attempt. See `maxAttempts`. */
  retryDelayMs?: number;
}

/**
 * Validate a task before registering it. Throws on misconfiguration so the
 * scheduler doesn't silently drop tasks.
 */
export function validateScheduledTask(task: ScheduledTask): void {
  if (!task.taskId) throw new Error('ScheduledTask.taskId is required');
  if (!task.command) throw new Error(`task ${task.taskId}: command is required`);
  if (task.trigger === 'cron' || task.trigger === 'both') {
    if (!task.cronExpression && !task.runAt) {
      throw new Error(`task ${task.taskId}: cronExpression required for trigger=${task.trigger}`);
    }
  }
  if (task.trigger === 'pull' && task.cronExpression !== undefined) {
    throw new Error(
      `task ${task.taskId}: cronExpression must not be set when trigger='pull' — pull tasks are dequeued from the queue directory, not scheduled via cron`,
    );
  }
  if (task.runAt !== undefined) {
    const ms = Date.parse(task.runAt);
    if (isNaN(ms)) {
      throw new Error(`task ${task.taskId}: runAt must be a valid ISO 8601 date string`);
    }
    if (task.cronExpression !== undefined) {
      throw new Error(
        `task ${task.taskId}: runAt and cronExpression are mutually exclusive — use one or the other`,
      );
    }
  }
  if (task.expiresAt !== undefined) {
    const ms = Date.parse(task.expiresAt);
    if (isNaN(ms)) {
      throw new Error(`task ${task.taskId}: expiresAt must be a valid ISO 8601 date string`);
    }
  }
  const executor = task.executor ?? 'agent';
  if (executor === 'builtin' && !KNOWN_BUILTINS.includes(task.command as BuiltinTaskName)) {
    throw new Error(
      `task ${task.taskId}: unknown builtin '${task.command}' — known: ${KNOWN_BUILTINS.join(', ')}`,
    );
  }
  if (task.cwd !== undefined && (typeof task.cwd !== 'string' || !task.cwd)) {
    throw new Error(`task ${task.taskId}: cwd must be a non-empty string when set`);
  }
  // Validate retry fields with the same bounds as the input surfaces so a
  // hand-edited schedules.json is caught at registration, not silently clamped.
  if (task.maxAttempts !== undefined) {
    if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > TASK_MAX_ATTEMPTS_LIMIT) {
      throw new Error(
        `task ${task.taskId}: maxAttempts must be an integer between 1 and ${TASK_MAX_ATTEMPTS_LIMIT}`,
      );
    }
  }
  if (task.retryDelayMs !== undefined) {
    if (!Number.isInteger(task.retryDelayMs) || task.retryDelayMs < TASK_RETRY_DELAY_MIN_MS || task.retryDelayMs > TASK_RETRY_DELAY_MAX_MS) {
      throw new Error(
        `task ${task.taskId}: retryDelayMs must be an integer between ${TASK_RETRY_DELAY_MIN_MS} and ${TASK_RETRY_DELAY_MAX_MS}`,
      );
    }
  }
}
