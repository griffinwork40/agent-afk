/**
 * Implementation of the `get_background_job_health` tool.
 *
 * Returns a coarse health snapshot for a background subagent job owned by the
 * calling session: status, elapsed time, idle-since duration (for running
 * jobs), pending steering message count, and recent progress events.
 *
 * Ownership is enforced via `parentSessionId` — a session can only inspect
 * its own jobs. Unknown job IDs never leak other IDs to the caller.
 *
 * @module agent/tools/subagent/background-health
 */

import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { ToolCall, ToolResult } from '../types.js';

/**
 * Execute the `get_background_job_health` tool call.
 *
 * @param registry - The session's background job registry, or undefined when
 *   background mode is not available.
 * @param call - The raw tool call from the model.
 * @param callerSessionId - The calling session's id, used for ownership checks.
 */
export function getBackgroundJobHealth(
  registry: BackgroundAgentRegistry | undefined,
  call: ToolCall,
  callerSessionId?: string,
): ToolResult {
  const input = call.input as Record<string, unknown>;
  const jobId = typeof input['jobId'] === 'string' ? input['jobId'].trim() : '';

  if (!jobId) {
    return { content: 'get_background_job_health requires a non-empty jobId string.', isError: true };
  }
  if (!registry) {
    return { content: 'Background mode is not available in this session.', isError: true };
  }

  const job = registry.get(jobId);
  if (!job) {
    // Do NOT list other job IDs — that would be an information leak.
    return { content: `Background job not found: "${jobId}".`, isError: true };
  }

  // Ownership check: only the creating session can inspect.
  if (callerSessionId && job.parentSessionId !== callerSessionId) {
    return { content: `Background job "${jobId}" belongs to a different session.`, isError: true };
  }

  const now = Date.now();
  const elapsedMs = now - job.startedAt;
  const lastActivityAt = job.lastActivityAt ?? job.startedAt;
  const idleSinceMs = job.status === 'running' ? now - lastActivityAt : undefined;

  // Gather handle-level signals if the job is still running.
  const handle = job.status === 'running' ? registry.getHandle(jobId) : undefined;

  // Build the health snapshot.
  const health: Record<string, unknown> = {
    jobId: job.jobId,
    status: job.status,
    model: job.model,
    label: job.label || null,
    startedAt: new Date(job.startedAt).toISOString(),
    elapsedMs,
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    ...(idleSinceMs !== undefined ? { idleSinceMs } : {}),
    ...(job.endedAt !== undefined ? { endedAt: new Date(job.endedAt).toISOString() } : {}),
  };

  // Handle-level signals (only for running jobs we own).
  if (handle) {
    // Pending steering messages not yet consumed.
    const handleAny = handle as unknown as Record<string, unknown>;
    const steeringQueue = handleAny['_steeringMessages'];
    if (Array.isArray(steeringQueue)) {
      health['pendingSteeringMessages'] = steeringQueue.length;
    }

    // Last progress events (child-reported via emit_progress).
    const progressRing = handleAny['_progressEvents'];
    if (Array.isArray(progressRing) && progressRing.length > 0) {
      // Surface the last 5 progress events (most recent at the end).
      health['recentProgressEvents'] = progressRing.slice(-5);
    }
  }

  return { content: JSON.stringify(health, null, 2) };
}
