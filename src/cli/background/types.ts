/**
 * Unified background-item type bridging the two facilities:
 *
 * - `BackgroundTask` from BackgroundTaskManager (turn-detach, Ctrl+B / /bg)
 * - `BackgroundJob` from BackgroundAgentRegistry (subagent-detach, agent tool mode:'background')
 *
 * Consumers like the unified status bar and /tasks slash command iterate
 * BackgroundItem[] so they don't need to know which facility produced each row.
 *
 * @module cli/background/types
 */

import type { BackgroundTask } from '../commands/interactive/background.js';
import type { BackgroundJob } from '../../agent/background-registry.js';

export type BackgroundItem =
  | { kind: 'turn'; task: BackgroundTask }
  | { kind: 'subagent'; job: BackgroundJob };

/** Stable identifier for a BackgroundItem, regardless of kind. */
export function itemId(item: BackgroundItem): string {
  return item.kind === 'turn' ? item.task.id : item.job.jobId;
}

/** Start timestamp (ms epoch). Use for recency sort. */
export function itemStartedAt(item: BackgroundItem): number {
  return item.kind === 'turn' ? item.task.startedAt : item.job.startedAt;
}

/** True when the item is still running (terminal kinds return false). */
export function itemIsRunning(item: BackgroundItem): boolean {
  return item.kind === 'turn' ? item.task.status === 'running' : item.job.status === 'running';
}
