/**
 * Lite read-only snapshot helpers for `SubagentExecutor.getSubagentsLite()`.
 *
 * Extracted from subagent-executor.ts to satisfy the file-size ceiling.
 * Returns a minimal shape that the `get_runtime_state` tool's `subagents`
 * view can serialise without exposing `SubagentHandle` references or raw
 * `BackgroundJob` internals.
 *
 * @module agent/tools/subagent-executor.lite-snapshot
 */

import type { SubagentManager } from '../subagent.js';
import type { BackgroundAgentRegistry } from '../background-registry.js';

export interface SubagentsLite {
  active: Array<{
    id: string;
    status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  }>;
  backgroundJobs: Array<{
    jobId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: string;
    label: string | null;
  }>;
}

/**
 * Build a lite snapshot of active subagents and background jobs. Pulls fresh
 * from the manager + registry on every call so live counts are visible.
 * Background `startedAt` is converted from epoch-ms to ISO 8601 to match the
 * rest of the snapshot's timestamp convention.
 */
export function buildSubagentsLite(
  subagentManager: SubagentManager,
  backgroundRegistry: BackgroundAgentRegistry | undefined,
): SubagentsLite {
  const active = subagentManager
    .list()
    .map((h) => ({ id: h.id, status: h.status }));
  const backgroundJobs = backgroundRegistry
    ? backgroundRegistry.list().map((j) => ({
        jobId: j.jobId,
        status: j.status,
        startedAt: new Date(j.startedAt).toISOString(),
        label: j.label.length > 0 ? j.label : null,
      }))
    : [];
  return { active, backgroundJobs };
}
