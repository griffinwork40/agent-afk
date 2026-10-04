/**
 * Builtin task descriptors for the daemon command.
 *
 * Extracted from `src/cli/commands/daemon.ts` to respect the 200-line
 * function ceiling on `registerDaemonCommand`. Each helper builds the
 * {@link ScheduledTask} object for one builtin and is the single place that
 * owns the cron default and any task-level policy (e.g. `notifyOn`).
 *
 * @module cli/commands/daemon-builtin-tasks
 */

import type { ScheduledTask } from '../../agent/daemon/triggers.js';
import type { CliConfig } from '../config/types.js';

// ---------------------------------------------------------------------------
// worktree-prune
// ---------------------------------------------------------------------------

/**
 * Build the worktree-prune builtin task descriptor.
 *
 * @param cron - Cron expression (from config or default '0 4 * * *').
 */
export function buildWorktreePruneTask(cron: string): ScheduledTask {
  return {
    taskId: 'worktree-prune',
    executor: 'builtin',
    command: 'worktree-prune',
    trigger: 'cron',
    cronExpression: cron,
  };
}

// ---------------------------------------------------------------------------
// tool-health
// ---------------------------------------------------------------------------

/**
 * Build the tool-health builtin task descriptor.
 *
 * IMPORTANT: `notifyOn` MUST be `'failure'`. The legacy default (no `notifyOn`
 * field) fires `onTaskComplete` on every run — success AND error — which would
 * send a Telegram push on every clean hourly check. Only the `'error'` path
 * (a degraded-tool alert) should reach the operator.
 *
 * @param cron - Cron expression (from config or default '17 * * * *').
 */
export function buildToolHealthTask(cron: string): ScheduledTask {
  return {
    taskId: 'tool-health',
    executor: 'builtin',
    command: 'tool-health',
    trigger: 'cron',
    cronExpression: cron,
    // notifyOn: 'failure' is required — see JSDoc above for the invariant.
    notifyOn: 'failure',
  };
}

// ---------------------------------------------------------------------------
// Combined builtin task set
// ---------------------------------------------------------------------------

/**
 * Resolve and append enabled builtin tasks (worktree-prune, tool-health) to
 * the provided `tasks` array. Extracted from `registerDaemonCommand` to keep
 * that function under the 200-line ceiling.
 *
 * @param tasks   - Mutable task array to append to.
 * @param config  - Resolved CLI config.
 * @param env     - Env values subset (disable flags).
 */
export function appendBuiltinTasks(
  tasks: ScheduledTask[],
  config: { daemon?: CliConfig['daemon'] },
  env: { AFK_WORKTREE_PRUNE_DISABLE?: string; AFK_TOOL_HEALTH_DISABLE?: string },
): { worktreePruneCron: string; toolHealthCron: string; worktreePruneEnabled: boolean; toolHealthEnabled: boolean } {
  const worktreePruneConfig = config.daemon?.worktreePrune;
  const worktreePruneEnabled =
    env.AFK_WORKTREE_PRUNE_DISABLE !== '1' && worktreePruneConfig?.enabled !== false;
  const worktreePruneCron = worktreePruneConfig?.cron ?? '0 4 * * *';
  if (worktreePruneEnabled) tasks.push(buildWorktreePruneTask(worktreePruneCron));

  const toolHealthConfig = config.daemon?.toolHealth;
  const toolHealthEnabled =
    env.AFK_TOOL_HEALTH_DISABLE !== '1' && toolHealthConfig?.enabled !== false;
  const toolHealthCron = toolHealthConfig?.cron ?? '17 * * * *';
  if (toolHealthEnabled) tasks.push(buildToolHealthTask(toolHealthCron));

  return { worktreePruneCron, toolHealthCron, worktreePruneEnabled, toolHealthEnabled };
}
