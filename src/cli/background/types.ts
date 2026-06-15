/**
 * Unified background-item type for background subagent jobs.
 *
 * - `BackgroundJob` from BackgroundAgentRegistry (subagent-detach, agent tool mode:'background')
 *
 * Consumers like the unified status bar and /tasks slash command iterate
 * BackgroundItem[] so they don't need to know which facility produced each row.
 *
 * @module cli/background/types
 */

import type { BackgroundJob } from '../../agent/background-registry.js';

export type BackgroundItem = { kind: 'subagent'; job: BackgroundJob };

/** Stable identifier for a BackgroundItem. */
export function itemId(item: BackgroundItem): string {
  return item.job.jobId;
}

/** Start timestamp (ms epoch). Use for recency sort. */
export function itemStartedAt(item: BackgroundItem): number {
  return item.job.startedAt;
}

/** True when the item is still running (terminal kinds return false). */
export function itemIsRunning(item: BackgroundItem): boolean {
  return item.job.status === 'running';
}
