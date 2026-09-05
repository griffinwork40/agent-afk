import type { SubagentResult } from './subagent.js';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type BackgroundJobProvenance = 'model' | 'user';

export interface BackgroundJob {
  readonly jobId: string;
  readonly provenance: BackgroundJobProvenance;
  readonly subagentId: string;
  readonly label: string;
  readonly model: string;
  readonly startedAt: number;
  readonly status: BackgroundJobStatus;
  readonly result?: SubagentResult;
  readonly endedAt?: number;
  /** Session that created this job. Used for cross-session ownership checks. */
  readonly parentSessionId?: string;
}
