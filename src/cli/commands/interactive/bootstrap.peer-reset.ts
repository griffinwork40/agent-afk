import type { InteractiveCtx } from './shared.js';
import type { TraceSink } from '../../../agent/trace/index.js';

/**
 * Contract: isolate buffered state from the outgoing conversation before
 * installing the incoming session's boundary adapter; future notifier events
 * must use the incoming live trace writer, not the sealed outgoing one.
 */
export function resetResumedPeerContext(ctx: InteractiveCtx, writer: TraceSink | undefined): void {
  ctx.clearVerdictLedger?.();
  ctx.clearBgResultBuffer?.();
  ctx.clearPendingStopInjection?.();
  if (writer === undefined) delete ctx.traceWriter;
  else ctx.traceWriter = writer;
  ctx.reinstallPeerBoundary?.();
}
