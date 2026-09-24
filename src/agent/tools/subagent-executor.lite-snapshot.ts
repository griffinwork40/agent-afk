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
    /**
     * Rolling tail of the child's output text (~4 KB cap). Only populated for
     * jobs owned by the calling session (parentSessionId match). Absent for
     * user-promoted jobs (Ctrl+B) whose transcript was not captured, and for
     * jobs owned by a different session.
     */
    recentActivity?: string;
  }>;
}

/** Maximum chars (UTF-16 code units) of transcript tail surfaced in the lite snapshot. */
const MAX_ACTIVITY_SNAPSHOT_CHARS = 2048;

/**
 * Build a lite snapshot of active subagents and background jobs. Pulls fresh
 * from the manager + registry on every call so live counts are visible.
 * Background `startedAt` is converted from epoch-ms to ISO 8601 to match the
 * rest of the snapshot's timestamp convention.
 *
 * When `callerSessionId` is provided, running jobs owned by that session
 * include a `recentActivity` field with the last ~2 KB of output text.
 */
export function buildSubagentsLite(
  subagentManager: SubagentManager,
  backgroundRegistry: BackgroundAgentRegistry | undefined,
  callerSessionId?: string,
): SubagentsLite {
  const active = subagentManager
    .list()
    .map((h) => ({ id: h.id, status: h.status }));
  const backgroundJobs = backgroundRegistry
    ? backgroundRegistry.list().map((j) => {
        const base = {
          jobId: j.jobId,
          status: j.status,
          startedAt: new Date(j.startedAt).toISOString(),
          label: j.label.length > 0 ? j.label : null,
        };
        // Only surface transcript for the caller's own running model-dispatched jobs.
        // User-promoted (Ctrl+B) jobs are excluded structurally via j.provenance === 'model'
        // (their transcript is also empty in practice, but the provenance check makes the
        // exclusion explicit rather than incidental).
        if (
          callerSessionId &&
          j.parentSessionId === callerSessionId &&
          j.status === 'running' &&
          j.provenance === 'model'
        ) {
          const tail = backgroundRegistry.getTranscript(j.jobId);
          if (tail && tail.length > 0) {
            const trimmed = tail.length > MAX_ACTIVITY_SNAPSHOT_CHARS
              ? tail.slice(tail.length - MAX_ACTIVITY_SNAPSHOT_CHARS)
              : tail;
            return { ...base, recentActivity: trimmed };
          }
        }
        return base;
      })
    : [];
  return { active, backgroundJobs };
}
