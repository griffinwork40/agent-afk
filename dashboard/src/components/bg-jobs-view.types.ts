/**
 * Types and pure helpers for the background-jobs view.
 * Sibling of bg-jobs-view.tsx — no React imports here.
 */

/** Mirror of src/agent/bg-job-log.ts BgJobMeta (schemaVersion 1). */
export interface BgJobMeta {
  jobId: string;
  subagentId: string;
  label: string;
  /** SHA-256 hex of the original prompt — never the prompt text itself. */
  promptHash: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  parentSessionId?: string;
  /**
   * Terminal SubagentResult.stopReason — only present on failed/cancelled jobs
   * written after the field was added. Optional and additive.
   */
  stopReason?: string;
  schemaVersion: 1;
}

/** Return how long a job ran (or has been running). */
export function formatDuration(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Human-readable elapsed time since a timestamp, e.g. "3m ago". */
export function formatRelative(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Strip org prefix from model names for compact display. */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash !== -1 ? model.slice(slash + 1) : model;
}

export const STATUS_STYLES: Record<BgJobMeta['status'], string> = {
  running: 'bg-green-500/20 text-green-400 border border-green-500/30',
  completed: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  failed: 'bg-red-500/20 text-red-400 border border-red-500/30',
  cancelled: 'bg-neutral-500/20 text-neutral-400 border border-neutral-500/30',
};

/** True when no more output is expected from a job. */
export function isSettled(job: BgJobMeta): boolean {
  return job.status !== 'running';
}
