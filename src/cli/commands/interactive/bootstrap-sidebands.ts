import type { SessionRef } from '../../../agent/session-ref.js';
import type { createBootstrapInfra } from './bootstrap-infra.js';

/** Live SessionRef routing keeps rollups and sidebands correct across resume. */
export function wireSessionSidebands(
  sessionRef: SessionRef,
  rootManager: ReturnType<typeof createBootstrapInfra>['rootManager'],
  composeExecutor: ReturnType<typeof createBootstrapInfra>['composeExecutor'],
  backgroundRegistry: ReturnType<typeof createBootstrapInfra>['backgroundRegistry'],
): void {
  // Witness layer: wire the subagent-success rollup so the rootManager's
  // foreground forks accumulate token/cost data into the parent session's
  // session_sealed payload. Late-bound here because session is constructed
  // after rootManager to avoid a circular reference.
  //
  // Read through `sessionRef.current` (not the closed-over `session`) so a
  // mid-session `/resume` swap — which rebinds `sessionRef.current` to a
  // freshly built AgentSession via performResumeSwap — routes subsequent
  // subagent completions into the live session's accumulators. Closing over
  // `session` would silently strand post-resume rollups on the old, discarded
  // session, dropping them from the active session's session_sealed payload.
  const onSubagentSucceeded = (usage: import('../../../agent/subagent/result.js').SubagentTrace['usage'], costUsd: number | undefined): void => {
    sessionRef.current?.recordSubagentCompletion(usage, costUsd);
  };
  rootManager.setOnSubagentSucceeded(onSubagentSucceeded);
  // Wire the same rollup for compose DAG nodes. The compose executor creates
  // a fresh SubagentManager per execute() call, so setOnSubagentSucceeded on
  // rootManager does not reach compose node costs — they require their own
  // wiring here. Without this, compose node token/cost data is silently
  // dropped from session_sealed telemetry.
  composeExecutor.setOnSubagentSucceeded(onSubagentSucceeded);

  // Step 1A: wire subagent_lifecycle and background_job OutputEvent emission.
  // Read through sessionRef so post-resume swaps route into the live session.
  const sidebandSink = (event: import('../../../agent/types/session-types.js').OutputEvent): void => {
    sessionRef.current?.pushSidebandEvent(event);
  };
  rootManager.setOutputEventSink(sidebandSink);
  // Wire background_job events via the registry's existing EventEmitter API.
  backgroundRegistry.on('started', (job) => {
    sidebandSink({ type: 'background_job', jobId: job.jobId, status: 'started', label: job.label });
  });
  backgroundRegistry.on('settled', (job) => {
    const status = job.status === 'completed' ? 'completed' as const
      : job.status === 'failed' ? 'failed' as const
      : 'cancelled' as const;
    sidebandSink({ type: 'background_job', jobId: job.jobId, status, label: job.label });
  });

}
