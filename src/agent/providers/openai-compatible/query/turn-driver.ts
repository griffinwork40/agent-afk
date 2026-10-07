/**
 * Per-turn inner loop for the openai-compatible provider.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — see issue #2565.
 * Mirrors the Anthropic provider's `query-turn-driver.ts` split.
 *
 * Context contract:
 *   The caller (OpenAICompatibleQuery) implements `TurnDriverContext` and
 *   passes `this` directly, so every accessor reflects the live instance.
 *   Never pass a plain object literal with getters — `this` inside those
 *   getters would be the literal, not the query instance.
 *
 * @module agent/providers/openai-compatible/query/turn-driver
 */

import type { ProviderEvent, ProviderUsage, ProviderUserTurn } from '../../../provider.js';
import { sumProviderUsage } from '../../../usage.js';
import { DenialCircuitBreakerError } from '../../../../utils/errors.js';
import {
  isTruncationStopReason,
  truncationNotice,
} from '../../shared/truncation.js';
import {
  TOOL_USE_LOOP_CAPPED,
  resolveMaxToolIterations,
  shouldWindDown,
  roundDeliveryNotice,
} from '../../shared/tool-loop-cap.js';
import {
  SOFT_DEADLINE_WIND_DOWN,
  softDeadlineExpired,
} from '../../shared/soft-deadline.js';
import { buildRoundProgressEvent } from './turn-driver.progress.js';
import { supportsVision } from '../../../model-capabilities.js';
import { usageFromState, finalizedToolCalls, type StreamState } from '../translate.js';
import { checkContextOverflow } from './context-overflow.js';
import { roundContextWindowTokens } from './turn-driver.context-window.js';
import {
  runIteration,
  finishTurn,
  pushUserTurn,
  type IterationContext,
  type FinishTurnContext,
} from './turn-iteration.js';
import { runIterationWithOverloadPause } from './overload-pause-tier.js';
import { runIterationWithQuotaLimitPause } from './usage-limit-tier.js';
import type { ToolResult } from '../../anthropic-direct/types.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';
import { dispatchAndAppendToolCalls } from './dispatch-append.js';
import type { ToolDispatcher } from '../../anthropic-direct/tool-dispatcher.js';
import type { TraceSink } from '../../../trace/index.js';
import type { OpenAIMessage } from '../messages.js';
import type { OpenAIJournalWiring } from './journal-wiring.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { OpenAIAuthResolution } from '../auth.js';
import { emitQueuedUserMessage } from '../../../trace/emit.js';

/** Full context the inner turn driver needs from the owning query. */
export interface TurnDriverContext extends IterationContext, FinishTurnContext {
  /** Abort coordinator — shared with the outer turn loop. */
  readonly abort: AbortCoordinator;
  readonly toolDispatcher: ToolDispatcher | undefined;
  readonly traceWriter: TraceSink | undefined;
  /** Options bag — read for config.subagentId, config.maxToolUseIterations, etc. */
  readonly opts: {
    readonly config: AgentConfig;
    readonly auth: OpenAIAuthResolution;
  };
  readonly journal: OpenAIJournalWiring;
  readonly priorTurns: OpenAIMessage[];
  readonly initSessionId: string;
  /** Mutable — must read live; changed by setModel(). */
  readonly currentModel: string;
  /** Mutable — must read live; changed by setPermissionMode(). */
  readonly currentPermissionMode: string;
  /** Mutable — set true by close(). */
  readonly closed: boolean;
  /** Inter-round steering callback; set via setBeforeNextRound(). Read live. */
  readonly beforeNextRound: (() => string | undefined) | undefined;
  /**
   * Provider-side seam: blocking Stop hook → same-turn continuation (issue #2714).
   * Mirrors RunTurnInput.beforeTurnEnd for the anthropic-direct provider.
   * Called once per natural turn end (not wind-down, not abort, not truncation).
   * Returns `{ continueWith: string }` to continue the turn, or undefined to end.
   *
   * Finding 3: optional second arg threads the just-finished assistant text
   * directly so buildStopContext doesn't need to scan stale history.
   */
  readonly beforeTurnEnd: ((continuation: number, assistantText?: string) => Promise<{ continueWith?: string } | undefined>) | undefined;
}

/**
 * Inject inter-round steering text from `beforeNextRound()` onto the last
 * tool-result user message, mirroring anthropic-direct/loop/inter-round.ts.
 */
export function applyBeforeNextRound(
  priorTurns: OpenAIMessage[],
  steeringText: string | undefined,
  traceWriter: TraceSink | undefined,
  subagentId: string | undefined,
): void {
  if (!steeringText) return;
  const last = priorTurns.at(-1);
  // Invariant: OpenAI tool results are `role:'tool'` messages, so after an
  // ordinary tool round the tail is NOT a user message. The callback has
  // already drained the steering queue, so returning here would lose the
  // text; append a fresh user turn instead (valid after tool{} messages —
  // dispatch-append.ts uses the same shape for queued/image follow-ups).
  if (!last || last.role !== 'user') {
    priorTurns.push({ role: 'user', content: steeringText } as OpenAIMessage);
  } else if (typeof last.content === 'string') {
    last.content = last.content + '\n\n' + steeringText;
  } else if (Array.isArray(last.content)) {
    (last.content as Array<{ type: string; text: string }>).push({ type: 'text', text: steeringText });
  }
  void emitQueuedUserMessage(traceWriter, {
    jobId: subagentId ?? '',
    subagentId: subagentId ?? '',
    byteLength: Buffer.byteLength(steeringText, 'utf8'),
  });
}

/**
 * Apply inter-round steering and immediately sync the journal.
 *
 * Invariant: `dispatchAndAppend` already synced the journal at round-end, but
 * steering text appended AFTER that sync is invisible to JournalSync (same object
 * reference, no diff detected). Syncing here ensures the steering content is
 * persisted before the next model request — mirrors anthropic-direct's
 * inter-round sync (loop/inter-round.ts).
 */
export function applyAndSyncSteering(ctx: TurnDriverContext): void {
  const steeringText = ctx.beforeNextRound?.();
  applyBeforeNextRound(ctx.priorTurns, steeringText, ctx.traceWriter, ctx.opts.config.subagentId);
  if (steeringText) ctx.journal.sync(ctx.priorTurns);
}

/**
 * Build a composited iteration factory: quota-limit park (outer) wrapping
 * overload-pause (inner) wrapping the raw stream iteration.
 *
 * Extracted so `runTurnInner` stays under the 200-line function ceiling.
 * All parameters are explicit — no closure over outer locals.
 */
function makeCompositeIteration(
  ctx: TurnDriverContext,
  controller: AbortController,
  vision: boolean,
  windDownReason: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | null,
): ReturnType<typeof runIterationWithQuotaLimitPause> {
  return runIterationWithQuotaLimitPause(
    () => runIterationWithOverloadPause(
      () => runIteration(ctx, controller, vision, windDownReason),
      {
        surface: ctx.opts.config.surface,
        traceWriter: ctx.traceWriter,
        signal: controller.signal,
        isClosed: () => ctx.closed,
        sessionId: ctx.initSessionId,
      },
    ),
    {
      autoResumeOnUsageLimit: ctx.opts.config.autoResumeOnUsageLimit ?? true,
      traceWriter: ctx.traceWriter,
      signal: controller.signal,
      isClosed: () => ctx.closed,
      sessionId: ctx.initSessionId,
    },
  );
}

/**
 * Dispatch tool calls, append history, and sync the journal.
 * Extracted helper so `runTurnInner` stays under 200 lines.
 */
async function* dispatchAndAppend(
  ctx: TurnDriverContext,
  state: StreamState,
  signal: AbortSignal,
  vision: boolean,
): AsyncGenerator<ProviderEvent, ToolResult | undefined> {
  const denialTrip = yield* dispatchAndAppendToolCalls({
    state,
    signal,
    vision,
    toolDispatcher: ctx.toolDispatcher,
    traceWriter: ctx.traceWriter,
    priorTurns: ctx.priorTurns,
    sessionId: ctx.initSessionId,
    subagentId: ctx.opts.config.subagentId,
  });
  ctx.journal.sync(ctx.priorTurns); // commit point: tool round (full results) on disk
  return denialTrip;
}

/**
 * Drive a single user turn through the model + tool loop.
 *
 * This is the body of `OpenAICompatibleQuery._runTurnInner`, extracted here so
 * query.ts stays under the 350-code-line ceiling and `_runTurnInner` (now a
 * one-line delegate) stays under the 200-line function ceiling.
 *
 * Loop shape:
 *   1. Push user message onto priorTurns.
 *   2. runIteration: one model call → stream → translate.
 *   3. If tools: dispatchAndAppend → GOTO 2.
 *   4. Else: emit assistant.message + turn.completed, exit.
 */
export async function* runTurnInner(
  ctx: TurnDriverContext,
  content: ProviderUserTurn['content'],
  controller: AbortController,
  turnStartTime: number,
  taskId: string,
): AsyncGenerator<ProviderEvent> {
  // Vision is fixed for the turn — model can only change between turns.
  const vision = supportsVision(ctx.currentModel);

  // Context-overflow guard (#962): fail fast before the provider rejects
  // with 400. Yields an error event (not throw) so the abort slot is cleared.
  const overflowErr = checkContextOverflow(
    ctx.lastUsage,
    ctx.currentModel,
    ctx.opts.config.maxOutputTokens,
    ctx.opts.config.model ?? ctx.currentModel,
  );
  if (overflowErr) {
    ctx.abort.clear(controller);
    yield { type: 'error', error: overflowErr };
    return;
  }

  // Finding 1: stop-hook-continuation counter lives OUTSIDE the outer loop so
  // it persists across same-turn re-entries (continuation rounds). Previously
  // this was inside a recursive call which reset it to 0 each time, making the
  // cap unreachable. The loop approach (matching anthropic-direct/loop.ts)
  // shares a single counter for the lifetime of the whole turn.
  let stopHookContinuation = 0;
  // Mutable content cursor — updated to the continuation message on each
  // blocking Stop hook re-entry instead of recursing.
  let currentContent = content;

  const maxIterations = resolveMaxToolIterations(ctx.opts.config.maxToolUseIterations);
  const softDeadlineMs = ctx.opts.config.softDeadlineMs ?? 0;

  // Outer loop: each iteration is one "mini-turn" (initial + any continuations
  // triggered by a blocking Stop hook). The vast majority of runs execute
  // exactly once; only blocking Stop hooks cause a second iteration.
  for (;;) {
    pushUserTurn(ctx, currentContent);

    // Reset per-iteration accumulators at the TOP so a continuation starts fresh.
    let accumulatedUsage: ProviderUsage = {
      stopReason: null,
      resultSubtype: 'success',
      isError: false,
    };
    let finalAssistantText = '';
    let finalReasoningText = '';
    let finalReasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content';
    let windDownReason: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | null = null;
    let round = 0;
    let toolCallCount = 0;
    // Invariant: tool calls that were being streamed when the output cap cut the
    // round off. `isToolCallStop` returns false for any truncation finish reason,
    // so a call truncated mid-arguments sets needsToolDispatch=false and is
    // discarded in-memory — it never reaches `dispatchAndAppend`, which is the
    // ONLY site that builds an assistant `tool_calls` message. That silent drop
    // is correct (a half-built call would poison history with an incomplete id).
    // The names are captured here for `emitTurnTerminal`'s truncation notice.
    let droppedToolNames: string[] = [];

    // Inner tool-use loop: keep driving the model as long as it emits tool calls.
    for (;;) {
      if (controller.signal.aborted) {
        ctx.abort.clear(controller);
        yield* finishTurn(ctx, accumulatedUsage, turnStartTime);
        return;
      }

      const result = yield* makeCompositeIteration(ctx, controller, vision, windDownReason);
      if (result === null) {
        ctx.abort.clear(controller);
        if (controller.signal.aborted || ctx.closed) {
          yield* finishTurn(ctx, accumulatedUsage, turnStartTime);
        }
        return;
      }

      const pricedModel = ctx.useOpenAIPricing ? ctx.currentModel : undefined;
      const roundUsage = usageFromState(result.state, pricedModel, ctx.fastTier.confirmedFast());
      accumulatedUsage = sumProviderUsage(accumulatedUsage, roundUsage);
      // Context-window footprint for this round; carries the last known value
      // forward (never 0) when the round had no usage. See the helper's Contract.
      accumulatedUsage.contextWindowTokens = roundContextWindowTokens(roundUsage, ctx.lastUsage);
      ctx.lastUsage = accumulatedUsage;
      if (result.text.length > 0) finalAssistantText = result.text;
      finalReasoningText = result.state.reasoningText;
      finalReasoningField = result.state.reasoningField;

      if (!result.needsToolDispatch) {
        if (isTruncationStopReason(result.state.finishReason)) {
          droppedToolNames = finalizedToolCalls(result.state).map((c) => c.name);
        }
        break;
      }

      if (windDownReason !== null) {
        // Wind-down round still asked for a tool (model fabricated one). Hard stop.
        break;
      }

      const denialTrip = yield* dispatchAndAppend(ctx, result.state, controller.signal, vision);
      if (denialTrip) {
        ctx.abort.clear(controller);
        yield { type: 'error', error: new DenialCircuitBreakerError(denialTrip.content) };
        return;
      }
      applyAndSyncSteering(ctx);
      round += 1;

      toolCallCount += finalizedToolCalls(result.state).length;
      yield buildRoundProgressEvent(
        ctx.initSessionId, result.state, taskId, round, maxIterations,
        accumulatedUsage, toolCallCount, turnStartTime,
      );

      if (controller.signal.aborted) {
        ctx.abort.clear(controller);
        yield* finishTurn(ctx, accumulatedUsage, turnStartTime);
        return;
      }

      const notice = roundDeliveryNotice(round, maxIterations);
      if (notice) {
        const lastTool = [...ctx.priorTurns].reverse().find(m => m.role === 'tool');
        if (lastTool && typeof lastTool.content === 'string') {
          lastTool.content += '\n\n' + notice;
        }
      }
      const roundsSpent = shouldWindDown(round, maxIterations);
      const timeSpent = softDeadlineExpired(turnStartTime, softDeadlineMs);
      if (roundsSpent || timeSpent) {
        windDownReason = roundsSpent ? TOOL_USE_LOOP_CAPPED : SOFT_DEADLINE_WIND_DOWN;
        continue;
      }
    }
    // — end inner tool-use loop —

    ctx.abort.clear(controller);

    // Push the final assistant turn to history. Echo reasoning under the same
    // wire field it arrived in (Cerebras uses `reasoning`; DeepSeek uses
    // `reasoning_content`) so the next request is not rejected with HTTP 400.
    if (finalAssistantText.length > 0) {
      const assistantTurn: OpenAIMessage = {
        role: 'assistant',
        content: finalAssistantText,
      };
      if (finalReasoningText.length > 0) {
        assistantTurn[finalReasoningField] = finalReasoningText;
      }
      ctx.priorTurns.push(assistantTurn);
    }

    // stop-hook-continuation rule: call beforeTurnEnd ONLY on natural ends.
    // Guards (same as anthropic-direct/loop.ts):
    //   - abort: signal already fired → skip (hook must not fight the budget)
    //   - truncation (max_tokens etc.): runtime output-ceiling → skip
    //   - wind-down round: iteration cap / soft-deadline → skip
    const isNaturalEnd = !controller.signal.aborted
      && !isTruncationStopReason(accumulatedUsage.stopReason)
      && windDownReason === null;

    if (isNaturalEnd && ctx.beforeTurnEnd !== undefined) {
      // Finding 3: pass finalAssistantText so buildStopContext gets fresh data
      // directly from the provider rather than scanning stale history.
      const seamResult = await ctx.beforeTurnEnd(stopHookContinuation, finalAssistantText);
      if (seamResult?.continueWith) {
        // A blocking Stop hook wants a same-turn continuation. Increment the
        // shared counter (Finding 1: counter is outside this loop so the cap
        // IS reachable), update the content cursor, and loop rather than recurse.
        stopHookContinuation += 1;
        currentContent = seamResult.continueWith;
        continue; // outer loop — next iteration pushes the continuation message
      }
      // Non-blocking: fall through to emit assistant.message and turn.completed.
    }

    yield* emitTurnTerminal(
      ctx,
      finalAssistantText,
      droppedToolNames,
      accumulatedUsage,
      windDownReason,
      turnStartTime,
    );
    return; // done — exit the outer loop
  }
  // — end outer continuation loop —
}

/**
 * Emit the terminal assistant.message event (with truncation notice appended
 * when the stop reason is a runtime output-token ceiling) followed by
 * `turn.completed`.
 *
 * Extracted from `runTurnInner` to keep it under the 200-line ceiling.
 * All parameters are explicit — no closure over outer locals.
 */
async function* emitTurnTerminal(
  ctx: TurnDriverContext,
  finalAssistantText: string,
  droppedToolNames: string[],
  accumulatedUsage: ProviderUsage,
  windDownReason: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | null,
  turnStartTime: number,
): AsyncGenerator<ProviderEvent> {
  // Invariant: the truncation notice is APPENDED to the single terminal
  // assistant.message, never yielded as a second one — last-wins consumers
  // (the non-streaming sendMessage() path, a subagent's final-message
  // capture) keep only the LAST assistant message of a turn, so a second
  // event would discard the model's real partial answer and surface only the
  // warning. Same rule as the anthropic-direct terminal path. Deliberately
  // applied AFTER the priorTurns push: the notice is operator-facing and
  // must not enter conversation history.
  //
  // Issue #970: textless truncations use the `notice` channel instead of
  // silently dropping. See the analogous logic in the anthropic-direct loop.
  const truncationText = isTruncationStopReason(accumulatedUsage.stopReason)
    ? truncationNotice(droppedToolNames, accumulatedUsage.stopReason, {
        canIncreaseOutputLimit: !(
          ctx.opts.auth.source === 'chatgpt-oauth' &&
          accumulatedUsage.stopReason === 'max_output_tokens'
        ),
      })
    : null;
  if (finalAssistantText.length > 0) {
    yield {
      type: 'assistant.message',
      text: truncationText
        ? `${finalAssistantText}\n\n${truncationText}`
        : finalAssistantText,
      sessionId: ctx.initSessionId,
    };
  } else {
    yield {
      type: 'assistant.message',
      text: finalAssistantText,
      sessionId: ctx.initSessionId,
    };
    if (truncationText !== null) {
      yield {
        type: 'notice',
        text: truncationText,
        kind: 'truncation' as const,
        sessionId: ctx.initSessionId,
      };
    }
  }

  yield* finishTurn(
    ctx,
    windDownReason !== null
      ? { ...accumulatedUsage, stopReason: windDownReason }
      : accumulatedUsage,
    turnStartTime,
  );
}
