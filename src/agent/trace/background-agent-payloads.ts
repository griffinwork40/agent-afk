export interface BackgroundAgentStartedPayload {
  transition: 'started';
  jobId: string;
  subagentId: string;
  label: string;
  model: string;
}

export interface BackgroundAgentCompletedPayload {
  transition: 'completed';
  jobId: string;
  subagentId: string;
  durationMs: number;
  outputBytes: number;
}

export interface BackgroundAgentFailedPayload {
  transition: 'failed';
  jobId: string;
  subagentId: string;
  durationMs: number;
  errorClass: string;
  errorMessage: string;
}

export interface BackgroundAgentCancelledPayload {
  transition: 'cancelled';
  jobId: string;
  subagentId: string;
  source: 'explicit' | 'cascade';
  cancelledBy?: 'model';
  reason?: string;
}

export interface BackgroundAgentJoinedPayload {
  transition: 'joined';
  jobId: string;
  subagentId: string;
  jobStatus: 'completed' | 'failed' | 'cancelled';
}

export interface BackgroundAgentDeliveredPayload {
  transition: 'delivered';
  jobId: string;
  subagentId: string;
  jobStatus: 'completed' | 'failed' | 'cancelled';
}

export type BackgroundAgentPayload =
  | BackgroundAgentStartedPayload
  | BackgroundAgentCompletedPayload
  | BackgroundAgentFailedPayload
  | BackgroundAgentCancelledPayload
  | BackgroundAgentJoinedPayload
  | BackgroundAgentDeliveredPayload;
