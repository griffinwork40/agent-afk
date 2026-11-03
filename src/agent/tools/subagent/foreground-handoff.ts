/** Synchronous phases of the foreground run; all inputs and lifetime state are explicit. */
import type { RunForegroundArgs, PromotedSubagentInfo } from './foreground-promotion.js';
import type { ToolResult } from '../types.js';
import type { SubagentResult } from '../../subagent/result.js';
import type { ContinuationResultFields } from './continuation-dispatch.js';
import type { QueuedNoteClaim } from './queued-note.js';
import { annotateIfIncomplete, incompleteToolResultFields } from '../../subagent/result.js';
import { emitTelemetry, truncate, boundedStopReason, measurePartial, buildFailurePayload } from './failure-payload.js';
import { capSubagentResult } from './foreground-promotion.result-cap.js';
import { withProvenanceHeader } from './foreground-promotion.provenance.js';
import { errorMessage } from '../../../utils/errors.js';
import { backgroundDeliveryNote, type BackgroundDelivery } from './background-delivery.js';
import { debugLog } from '../../../utils/debug.js';
import { teardownBackgroundWorktree } from '../handlers/worktree-managed.background.js';
import { describePreserveReason, type teardownIsolatedWorktree } from '../handlers/worktree-managed.js';
type RunPromise = ReturnType<RunForegroundArgs['handle']['runToResult']>;

export function foregroundPromotionPayload(
  job: { jobId: string; subagentId: string; label: string },
  delivery: BackgroundDelivery | undefined,
): Record<string, unknown> {
  return {
    status: 'running' as const,
    jobId: job.jobId,
    subagentId: job.subagentId,
    label: job.label,
    message:
      `Subagent backgrounded by user (jobId=${job.jobId}). It keeps running detached. ` +
      `${backgroundDeliveryNote(delivery, job.jobId)} ` +
      `/bgsub:join ${job.jobId} remains available for manual replay.`,
  };
}

export function reportPreservedForegroundWorktree(
  worktreePath: string,
  outcome: Awaited<ReturnType<typeof teardownIsolatedWorktree>>,
): void {
  debugLog(
    `[isolation] preserved worktree ${worktreePath} ` +
      `(${outcome.reason ? describePreserveReason(outcome.reason, outcome.ignoredDetail, outcome.ignoredBecause) : 'unknown'}) — ` +
      `locked so the sweep will not reap it; recover via the worktree tool`,
  );
}

export function prepareForegroundRun(args: RunForegroundArgs) {
  const { handle, signal, promotionTriggers, activeForegroundHandles } = args;
  // Wire abort: if signal fires, cancel the handle (foreground only —
  // see comment on the background branch above for why).
  const abortListener = () => {
    void handle.cancel();
  };
  signal.addEventListener('abort', abortListener, { once: true });

  const startedAt = Date.now();

  // ------------------------------------------------------------------
  // Promotion plumbing (user-triggered backgrounding of a running
  // foreground subagent — Ctrl+B).
  //
  // External constraint: the parent model is suspended at the single
  // `runToResult` await below for this subagent's entire lifetime, and
  // its progress reaches the UI through a side-channel progress sink —
  // NOT via events on the parent stream. So a keyboard flag polled in the
  // turn loop cannot interrupt this await. Instead we expose a promotion
  // trigger through the narrow SubagentControl seam: when fired, it wins a
  // race against the run; we hand the still-running handle to the
  // BackgroundAgentRegistry and return the same synthetic "running"
  // pointer the mode:'background' branch returns — unblocking the parent
  // turn while the subagent keeps running detached.
  //
  // `promoted` gates the finally so a promoted (detached) handle and its
  // child manager are NOT torn down here: the registry now owns the
  // handle's lifetime, bounded by parent-session abort exactly like a
  // natively-backgrounded job.
  // ------------------------------------------------------------------
  let firePromotion!: (queuedNote?: QueuedNoteClaim) => void;
  const promotionSignal = new Promise<QueuedNoteClaim | undefined>((resolve) => {
    firePromotion = resolve;
  });
  let resolveJob!: (info: PromotedSubagentInfo | null) => void;
  const jobReady = new Promise<PromotedSubagentInfo | null>((resolve) => {
    resolveJob = resolve;
  });
  promotionTriggers.set(handle.id, { fire: firePromotion, ready: jobReady });
  // Registry-independent cancel handle (soft-stop path). Removed in the same
  // finally as the promotion trigger below.
  activeForegroundHandles.set(handle.id, handle);

  return { abortListener, startedAt, promotionSignal, resolveJob };
}

export function emitForegroundRejection(
  args: Pick<RunForegroundArgs, 'identity' | 'handle' | 'idPrefix' | 'parentSessionId' | 'depth'>,
  err: unknown,
  startedAt: number,
): void {
  const { identity, handle, idPrefix, parentSessionId, depth } = args;
  const message = errorMessage(err);
  void emitTelemetry({
    ...identity,
    event: 'subagent.failed',
    subagent_id: handle.id,
    id_prefix: idPrefix,
    parent_session_id: parentSessionId,
    status: 'failed',
    duration_ms: Date.now() - startedAt,
    error_message: truncate(message),
    depth,
  });
}

/** Synchronous shaping keeps telemetry and result assignment in the race continuation. */
export function foregroundCompletionResult(
  args: Pick<RunForegroundArgs, 'handle' | 'identity' | 'parentSessionId' | 'depth' | 'model' | 'parentModel' | 'idPrefix'>,
  result: Awaited<RunPromise>,
  startedAt: number,
): ToolResult {
  const { handle, identity, parentSessionId, depth, model, parentModel, idPrefix } = args;
  // Extract success or failure
  if (result.status === 'succeeded' && result.message) {
    const rawContent = result.message.content;
    // Guard against non-string content (e.g. SDK may return a ContentBlock[])
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
    const trace = result.trace;
    // Invariant: `content`/`content_chars` are measured on the RAW message
    // content, before `annotateIfIncomplete`/`withProvenanceHeader` run
    // below. Telemetry must reflect the subagent's actual output size, not
    // the parent-visible banner/provenance text prepended at delivery time.
    void emitTelemetry({
      ...identity,
      event: 'subagent.completed',
      subagent_id: handle.id,
      parent_session_id: parentSessionId,
      status: result.status,
      duration_ms: Date.now() - startedAt,
      content_chars: content.length,
      // Bounded via the shared chokepoint (see failure-payload.ts) rather
      // than an inline `truncate(x, 64)` — that duplication (this site,
      // its failure-path sibling below, and background-registry.ts) is how
      // the sixth call site drifted unbounded (#717).
      stop_reason: boundedStopReason(result.stopReason),
      depth,
      tool_call_count: trace?.toolCalls.length,
      // Preserve `false` ("confirmed absent") distinctly from `undefined`
      // ("no trace available"); `|| undefined` would collapse both.
      thinking_present: trace != null ? trace.thinkingPresent : undefined,
      tool_names: trace?.toolCalls.length
        ? JSON.stringify([...new Set(trace.toolCalls.map(tc => tc.name))])
        : undefined,
    });
    // Invariant: the caller assigns this result before finally appends SubagentStop context.
    // annotateIfIncomplete marks capped/stream-truncated partials so the
    // parent model doesn't treat them as a final answer (no-op if clean);
    // withProvenanceHeader stamps the producing model on a mixed-model
    // dispatch (no-op when child == parent). incompleteToolResultFields adds
    // the structured counterpart to that same banner, alongside it, for
    // non-model consumers.
    const assembled = withProvenanceHeader(
      annotateIfIncomplete(content, result.stopReason),
      model,
      parentModel,
    );
    const { content: cappedContent, capped: wasCapped } = capSubagentResult(assembled, parentSessionId, handle.id);

    const toolResult: ToolResult & { _needsInput?: SubagentResult['needsInput'] } = {
      content: cappedContent,
      ...incompleteToolResultFields(result.stopReason),
      ...(wasCapped ? { truncated: true } : {}),
    };
    // Stash needsInput so prependNeedsInputHeader (called AFTER annotateChainResult
    // stamps continuation) can read it (#4297 F-C1).
    if (result.needsInput !== undefined) toolResult._needsInput = result.needsInput;
    return toolResult;
  }

  const errorMsg =
    result.error?.message ?? 'Subagent failed with no output';
  const failedTrace = result.trace;
  void emitTelemetry({
    ...identity,
    event: 'subagent.failed',
    subagent_id: handle.id,
    id_prefix: idPrefix,
    parent_session_id: parentSessionId,
    status: result.status,
    duration_ms: Date.now() - startedAt,
    error_message: truncate(errorMsg),
    schema_error: result.schemaError
      ? truncate(result.schemaError.message)
      : undefined,
    partial_output_chars: measurePartial(result.partialOutput),
    // Bounded via the shared chokepoint — see the completed-path comment above.
    stop_reason: boundedStopReason(result.stopReason),
    depth,
    // Mirror trace fields on the failure path — failed subagents are the
    // highest-value debugging target and benefit most from this signal.
    tool_call_count: failedTrace?.toolCalls.length,
    thinking_present: failedTrace != null ? failedTrace.thinkingPresent : undefined,
    tool_names: failedTrace?.toolCalls.length
      ? JSON.stringify([...new Set(failedTrace.toolCalls.map(tc => tc.name))])
      : undefined,
  });
  // Audit §F.1: surface a structured JSON payload to the parent model
  // instead of a plain error string, so the model can distinguish
  // schema mismatch / partial output / hard failure rather than seeing
  // a flattened "Subagent failed: ..." line.
  const payload = buildFailurePayload({
    status: result.status,
    errorMessage: errorMsg,
    schemaErrorMessage: result.schemaError?.message,
    partialOutput: result.partialOutput,
    subagentId: handle.id,
  });
  // Invariant: the caller assigns this result before finally appends SubagentStop context.
  // incompleteToolResultFields flags the ZERO-OUTPUT stream_incomplete case
  // (see `subagent/result.ts` — a pure cut-off-mid-flight run with nothing
  // to salvage resolves `status:'failed'` and routes through this exact
  // literal): without it that case's `stopReason` never reaches the
  // non-model consumers that key off `ToolResult.incomplete`. No-op
  // (adds nothing) for a clean failure or an absent stopReason.
  const toolResult: ToolResult = {
    content: JSON.stringify(payload),
    isError: true,
    ...incompleteToolResultFields(result.stopReason),
  };
  return toolResult;
}

/** No await here: adoption and caller ownership transfer stay in one race continuation. */
export function adoptForegroundRun(
  args: Pick<RunForegroundArgs, 'handle' | 'backgroundPrompt' | 'model' | 'parentSessionId' | 'budgetRelease'>,
  registry: NonNullable<RunForegroundArgs['registry']>,
  runPromise: RunPromise,
  isoTd: RunForegroundArgs['isolationTeardown'],
) {
  const { handle, backgroundPrompt, model, parentSessionId, budgetRelease } = args;
  return registry.adoptRunning({
    handle,
    runPromise,
    prompt: backgroundPrompt,
    model: model ?? 'sonnet',
    provenance: 'user-backgrounded',
    parentSessionId,
    ...(isoTd ? {
      onCleanup: async () => {
        const result = await teardownBackgroundWorktree(isoTd);
        debugLog(`background worktree teardown: ${JSON.stringify(result)}`);
      },
    } : {}),
    // Invariant: budget release belongs to registry settlement, never the foreground return.
    ...(budgetRelease !== undefined ? { onSettled: budgetRelease } : {}),
  });
}

/**
 * Prepend a structured `[needs_input]` header to a foreground tool result whose
 * child yielded an Asking block. Called AFTER `annotateChainResult` has stamped
 * `result.continuation`, so the chain ID is always available when one exists
 * (#4297 F-C1). No-op when the child did not yield.
 */
export function prependNeedsInputHeader(
  result: ToolResult & ContinuationResultFields & { _needsInput?: SubagentResult['needsInput'] },
): void {
  const ni = result._needsInput;
  if (ni === undefined) return;
  delete result._needsInput;
  const chainLine = result.continuation?.chainId
    ? `Chain ID (pass as continuation_chain_id to resume): ${result.continuation.chainId}`
    : 'No chain ID available — re-dispatch a fresh agent with the child\'s summary and your answer.';
  result.content =
    `[needs_input] This child yielded a question to you instead of completing.\n\n` +
    `Question: ${ni.question}\n` +
    (ni.assumption !== undefined ? `Assumption it resolves: ${ni.assumption}\n` : '') +
    (ni.onceAnswered !== undefined ? `Once answered: ${ni.onceAnswered}\n` : '') +
    `\n${chainLine}\n\n` +
    `To answer, dispatch a new \`agent\` call with \`continuation_chain_id\` set to the chain id above and ` +
    `include your answer as the prompt. If no chain id is shown, re-dispatch a fresh agent with the ` +
    `child's summary and your answer as the prompt.\n\n---\n${result.content}`;
}
