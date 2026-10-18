/**
 * Default-tier model fallback for subagent dispatch paths.
 *
 * When a child's model was chosen by the DEFAULT tier of resolveChildModel
 * (source === 'default' or 'floor') and the child fails with a
 * model-rejection error BEFORE producing any output, this module re-runs
 * the child once on the parent session model.
 *
 * Contract:
 *   - Only triggers when source is 'default' or 'floor' — explicit callSite,
 *     namedAgent, and parent choices fail loudly (respect operator intent).
 *   - Only triggers on model-rejection errors (classifyRejectedModel returns
 *     isModelRejection: true) — transient 429/5xx and account-level auth
 *     errors are untouched.
 *   - Does NOT retry when the fallback model equals the failed model (avoids
 *     infinite loops when the parent model is the same slot).
 *   - Prepends a visible warning line to the fallback result so the parent
 *     session sees what happened.
 *   - Emits a `subagent_model_fallback` session_phase trace event.
 *
 * @module agent/subagent/model-fallback
 */

import { classifyRejectedModel } from './rejected-model.js';
import type { ChildModelSource } from './resolve-child-model.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';
import type { ToolResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true when the model-source tier is eligible for automatic fallback.
 * Only 'default' and 'floor' are eligible — explicit callSite / namedAgent /
 * parent choices must fail loudly so operator intent is respected.
 */
export function isFallbackEligibleSource(source: ChildModelSource): boolean {
  return source === 'default' || source === 'floor';
}

// ---------------------------------------------------------------------------
// Trace event
// ---------------------------------------------------------------------------

/**
 * Emit the `subagent_model_fallback` session_phase trace event so the
 * witness layer makes the retry visible in `afk trace show`.
 */
function emitFallbackTrace(
  traceWriter: TraceSink | undefined,
  fromModel: string,
  toModel: string,
  reason: string,
): void {
  emitSessionPhase(traceWriter, {
    phase: 'subagent_model_fallback',
    metadata: { fromModel, toModel, reason },
  });
}

// ---------------------------------------------------------------------------
// Warning line
// ---------------------------------------------------------------------------

const WARNING_PREFIX = '[model-fallback]';

function buildWarningLine(failedModel: string, parentModel: string, reason: string): string {
  const shortReason = reason.length > 80 ? reason.slice(0, 80) + '…' : reason;
  return (
    `${WARNING_PREFIX} default subagent model "${failedModel}" was rejected` +
    ` (${shortReason}); re-ran on ${parentModel}\n`
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface ModelFallbackArgs {
  /** The ToolResult from the first (failed) child run. */
  firstResult: ToolResult;
  /** The model used for the first run. */
  failedModel: string;
  /** The provenance tier that chose failedModel. */
  source: ChildModelSource;
  /** The parent session model — the fallback target. */
  parentModel: string | undefined;
  /** Trace writer for the `subagent_model_fallback` event. */
  traceWriter: TraceSink | undefined;
  /** Re-run callback: receives the fallback model, returns a new ToolResult. */
  rerun: (fallbackModel: string) => Promise<ToolResult>;
}

/**
 * Attempt a model fallback when a default-tier child was rejected.
 *
 * Returns the fallback ToolResult (with a prepended warning line) when a
 * retry is warranted, or the original firstResult when it is not (wrong
 * source tier, non-model-rejection error, no parent model, or same model).
 */
export async function attemptModelFallback(args: ModelFallbackArgs): Promise<ToolResult> {
  const { firstResult, failedModel, source, parentModel, traceWriter, rerun } = args;

  // Only eligible for default/floor tiers.
  if (!isFallbackEligibleSource(source)) return firstResult;

  // Only trigger on model-rejection errors.
  const errorText = typeof firstResult.content === 'string' ? firstResult.content : '';
  const { isModelRejection, reason } = classifyRejectedModel(errorText);
  if (!isModelRejection) return firstResult;

  // Need a parent model to fall back to.
  if (parentModel === undefined || parentModel === '') return firstResult;

  // Do not retry when the fallback model equals the failed model.
  if (parentModel === failedModel) return firstResult;

  // Emit trace before the retry so the event is visible even if rerun throws.
  emitFallbackTrace(traceWriter, failedModel, parentModel, reason);

  const fallbackResult = await rerun(parentModel);

  // Prepend the warning line so the parent session sees the substitution.
  const warning = buildWarningLine(failedModel, parentModel, reason);
  const content =
    typeof fallbackResult.content === 'string'
      ? warning + fallbackResult.content
      : warning;

  return { ...fallbackResult, content };
}
