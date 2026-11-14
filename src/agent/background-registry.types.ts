import type { SubagentResult } from './subagent.js';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type BackgroundJobProvenance = 'model' | 'user' | 'user-backgrounded';

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
  /** Epoch-ms of the most recent observable activity (tool call, content chunk, progress event). */
  readonly lastActivityAt?: number;
  /**
   * Text of the active goal at the moment this job was dispatched. Used at
   * delivery time to detect whether the operator changed the goal while the
   * worker was running — if the current goal differs, the injection envelope
   * is annotated with `superseded="true"` so the model knows the result no
   * longer aligns with the active objective.
   *
   * Undefined when no goal was set at dispatch time (no annotation added).
   */
  readonly goalTextAtDispatch?: string;
}
