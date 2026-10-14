import type { InteractiveCtx } from './shared.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { TraceWriter } from '../../../agent/trace/writer.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';
import { performResumeSwap, resumeConfigFor } from './resume-swap.js';
import { buildAgentSession, buildSharedDeps } from './bootstrap-session-builder.js';
import type { createBootstrapInfra } from './bootstrap-infra.js';

/** Rebind every process-lived trace holder only after a successful swap. */
export function rebindResumeTraceWriter(
  ctx: Pick<InteractiveCtx, 'traceWriter'>,
  writer: TraceWriter | undefined,
  holders: readonly { setTraceWriter(writer: TraceWriter | undefined): void }[],
): void {
  if (writer === undefined) delete ctx.traceWriter;
  else ctx.traceWriter = writer;
  for (const holder of holders) holder.setTraceWriter(writer);
}

/** Drop outgoing-session queues synchronously after the resume pointer flip. */
function clearSwapBuffers(ctx: InteractiveCtx): void {
  ctx.clearVerdictLedger?.();
  ctx.clearBgResultBuffer?.();
  ctx.resetPeerNotifier?.();
  ctx.clearPendingStopInjection?.();
}

/** Own the pending writer and production onSwapped wiring without ambient refs. */
export function createResumeRequest(
  getCtx: () => InteractiveCtx,
  sessionRef: SessionRef,
  sharedDeps: ReturnType<typeof buildSharedDeps>,
  infra: Pick<ReturnType<typeof createBootstrapInfra>,
    'subagentExecutor' | 'skillExecutor' | 'composeExecutor' | 'rootManager' | 'backgroundRegistry' | 'processJobs'>,
  clearTrustedSkills: () => void,
  maxTurns: number,
): (target: ResolvedResumeTarget) => ReturnType<typeof performResumeSwap> {
  let pendingTraceWriter: TraceWriter | undefined;
  return (target) => {
    const ctx = getCtx();
    clearTrustedSkills();
    return performResumeSwap(target, {
      sessionRef, stats: ctx.stats, contextSampler: ctx.contextSampler,
      gitStatusSampler: ctx.gitStatusSampler, statusLine: ctx.statusLine,
      maxTurns: maxTurns > 0 ? maxTurns : undefined,
      backgroundRegistry: infra.backgroundRegistry, completionWriter: ctx.completionWriter,
      isInFlight: () => ctx.getInFlight?.() ?? false,
      onSwapped: (t) => {
        ctx.resumeTarget = t;
        clearSwapBuffers(ctx);
        // Build-time is too early: initialization can still roll back. The
        // outgoing writer is sealed on close; all live getters must move now.
        rebindResumeTraceWriter(ctx, pendingTraceWriter, [
          infra.subagentExecutor, infra.skillExecutor, infra.composeExecutor,
          infra.rootManager, infra.backgroundRegistry, infra.processJobs,
        ]);
        // Re-install the peer boundary callback on the resumed session so
        // mid-turn delivery works and old admission-queue entries are cleared.
        ctx.reinstallPeerBoundary?.();
        if (ctx.hasPendingUserMessage) {
          sessionRef.current?.setPlanExitQueueCheck(ctx.hasPendingUserMessage);
        }
      },
      buildSession: (t) => {
        const resumedLabel = t.stored?.sessionId;
        pendingTraceWriter = createDefaultTraceWriter(
          resumedLabel !== undefined ? { sessionLabel: resumedLabel } : {},
        )?.writer;
        return buildAgentSession({
          ...sharedDeps,
          model: t.stored?.model ?? sharedDeps.model,
          resumeConfig: resumeConfigFor(t),
          permissionMode: ctx.stats.permissionMode,
          traceWriter: pendingTraceWriter,
        });
      },
    });
  };
}
