/**
 * Default-tier model fallback, applied INSIDE a subagent handle's run.
 *
 * Invariant: this is the single choke point for the fallback. Every fork path
 * (agent tool foreground + background, skill forks, compose nodes, /mint
 * phases) runs its child through `SubagentHandleImpl.run()`, which calls
 * {@link streamWithModelFallback}. Callers only DECLARE eligibility by passing
 * `modelFallback` to `forkSubagent` (set solely when the child's model came
 * from the default tier and differs from the parent's model); the manager
 * turns that into a {@link HandleModelFallback} on the handle.
 *
 * Re-run happens at most once, and only when ALL hold:
 *   1. the first attempt's provider error classifies as a model rejection:
 *      either already a typed ModelRejectedError (ChatGPT backend, typed at
 *      the source) or a raw SDK error whose STRUCTURED fields (status, body
 *      type/code) say so — `classifyModelRejection`, never result prose;
 *   2. the child made ZERO progress: no completed assistant turn, no tool
 *      call, no streamed assistant text (read from the handle's own trace);
 *   3. the handle's controller is not aborted (parent abort / cancel / budget
 *      timeout all abort this same controller, so they also stop the retry).
 * The retry runs inside the same `run()` call: same controller, same
 * abort-graph node, same `withTimeout` budget, same delegation-budget receipt
 * (released once by the terminal hook), so nothing is double-counted.
 *
 * @module agent/subagent/handle.model-fallback
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { IAgentSession, Message } from '../types.js';
import type { SubagentProgressSink } from '../types/session-types.js';
import { classifyModelRejection } from '../providers/shared/model-rejected-error.js';
import { providerForModel } from '../providers/index.js';
import { emitSessionPhase } from '../trace/emit.js';
import { debugLog } from '../../utils/debug.js';
import type { RunBillingContext } from './handle.billing.js';
import type { SubagentHandleImpl } from './handle.js';
import { streamToFinalMessage } from './handle.streaming.js';

export interface HandleModelFallback {
  /** The default-tier model the child was forked on. */
  fromModel: string;
  /** The parent session model to re-run on. */
  toModel: string;
  /** Build the replacement child session (fallback model + its own credential/provider). */
  createSession: () => IAgentSession;
}

export const MODEL_FALLBACK_WARNING_PREFIX = '[model-fallback]';

/** True when the handle's current run produced nothing observable before failing. */
export function hasZeroProgress<T>(handle: SubagentHandleImpl<T>): boolean {
  const trace = handle._currentTrace;
  return trace.turnCount === 0 && trace.toolCalls.length === 0 && handle._lastStreamedContent.length === 0;
}

/** Build the visible warning line prepended to the fallback run's final message. */
export function buildModelFallbackWarning(fromModel: string, toModel: string, reason: string): string {
  const short = reason.replace(/\s+/g, ' ').slice(0, 160);
  return `${MODEL_FALLBACK_WARNING_PREFIX} default subagent model "${fromModel}" was rejected (${short}); re-ran on "${toModel}".\n\n`;
}

/**
 * Run the child once; on an eligible default-tier model rejection, swap the
 * child session onto the fallback model and run once more.
 */
export async function streamWithModelFallback<T>(
  handle: SubagentHandleImpl<T>,
  prompt: string | ContentBlockParam[],
  sinkOverride: SubagentProgressSink | undefined,
  billingContext: RunBillingContext,
): Promise<Message> {
  try {
    return await streamToFinalMessage(handle, prompt, sinkOverride, billingContext);
  } catch (err) {
    const fallback = handle._modelFallback;
    const rejection = fallback === undefined
      ? undefined
      : classifyModelRejection(err, fallback.fromModel, providerForModel(fallback.fromModel));
    if (
      fallback === undefined ||
      rejection === undefined ||
      handle._controller.signal.aborted ||
      !hasZeroProgress(handle) ||
      fallback.toModel === fallback.fromModel
    ) {
      throw err;
    }
    // One-shot: never chain a second fallback, even if the retry is rejected too.
    handle._modelFallback = undefined;
    const reason = rejection.message;
    await emitSessionPhase(handle._traceWriter, {
      phase: 'subagent_model_fallback',
      metadata: { subagentId: handle.id, fromModel: fallback.fromModel, toModel: fallback.toModel, reason: reason.slice(0, 200) },
    });
    const previous = handle.session;
    handle.session = fallback.createSession();
    // Best-effort close: the rejected session produced no progress, so any
    // close failure is a resource-cleanup concern only, not a correctness one.
    // Fire-and-forget is intentional; errors are logged but not propagated.
    void previous.close().catch((closeErr: unknown) => debugLog('model-fallback: closing rejected child session failed', closeErr));
    const message = await streamToFinalMessage(handle, prompt, sinkOverride, billingContext);
    return { ...message, content: buildModelFallbackWarning(fallback.fromModel, fallback.toModel, reason) + message.content };
  }
}
