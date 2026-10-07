import type { SubagentResult } from './subagent/result.js';
import { STREAM_INCOMPLETE } from './subagent/result.js';
import { runWithStreamCutRetry } from './subagent/stream-cut-retry.js';
import { isConnectionPhaseNetworkError, isConnectionTimeoutError } from './providers/shared/connection-error.js';
import { READ_ONLY_PHASE_TOOLS } from './tool-category.js';
import type { TraceSink } from './trace/index.js';
import { emitSessionPhase } from './trace/emit.js';

/** Compose has no nested dispatch. Only a mechanically enforced pure read surface qualifies. */
export function isComposeReplaySafe(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && tools.every((tool) => (READ_ONLY_PHASE_TOOLS.includes(tool) && tool !== 'workspace_publish') || tool === 'web_scrape');
}

export async function recoverDagNode(
  id: string,
  dispatch: () => Promise<SubagentResult>,
  signal: AbortSignal,
  sideEffectFree: boolean,
  traceWriter?: TraceSink,
): Promise<SubagentResult> {
  let last: SubagentResult;
  let lastEligible = false;
  const onAbort = (): void => {
    void emitSessionPhase(traceWriter, { phase: 'compose_recovery_decision',
      metadata: { nodeId: id, eligible: false, reason: 'aborted' } });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await runWithStreamCutRetry({
      signal,
      dispatch: async (attempt) => {
        last = await dispatch();
        const transport = last.status === 'failed' && (last.stopReason === STREAM_INCOMPLETE ||
          isConnectionPhaseNetworkError(last.error) || isConnectionTimeoutError(last.error));
        // Invariant: unknown traces fail closed; output and any non-read tool forbid replay.
        const hasOutput = last.trace?.thinkingPresent === true || last.partialOutput !== undefined || last.output !== undefined ||
          (last.message !== undefined && last.message.content !== '');
        const pureTrace = last.trace !== undefined && last.trace.toolCalls.every((call) =>
          isComposeReplaySafe([call.name]));
        // Invariant: `trace.toolCalls` is filled from the runtime's own `tool_use_detail` stream
        // events (subagent/handle.streaming.ts), which precede any tool execution, and
        // `toolResults` from completions. A known trace with neither proves no tool ran, so a
        // zero-output transport failure is replay-safe on ANY tool surface (the 853e8516 case:
        // unrestricted nodes that died on connect before their first tool call).
        const noToolActivity = last.trace !== undefined && last.trace.toolCalls.length === 0 &&
          last.trace.toolResults.length === 0;
        const safeEffects = noToolActivity || (sideEffectFree && pureTrace);
        const eligible = transport && !hasOutput && safeEffects && !signal.aborted;
        lastEligible = eligible;
        const reason = signal.aborted ? 'aborted' : !transport ? 'not_transport_failure' : hasOutput ? 'output_present' :
          !safeEffects ? (sideEffectFree ? 'unsafe_or_missing_trace' : 'unsafe_tool_surface') :
            attempt > 0 ? 'retry_exhausted' : noToolActivity && !sideEffectFree ? 'eligible_no_tool_activity' : 'eligible';
        void emitSessionPhase(traceWriter, { phase: 'compose_recovery_decision',
          metadata: { nodeId: id, attempt, eligible: eligible && attempt === 0, reason } });
        return { content: '', isError: last.status !== 'succeeded',
          ...(eligible ? { incompleteReason: STREAM_INCOMPLETE } : {}) };
      },
      canRedispatch: () => lastEligible && !signal.aborted,
      onRedispatch: (attempt) => {
        void emitSessionPhase(traceWriter, { phase: 'compose_recovery_decision',
          metadata: { nodeId: id, attempt, eligible: true, reason: 'redispatch' } });
      },
    });
    return last!;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
