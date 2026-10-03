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
  formatRoundLabel,
  resolveMaxToolIterations,
  shouldWindDown,
  pickRoundWarning,
} from '../../shared/tool-loop-cap.js';
import {
  SOFT_DEADLINE_WIND_DOWN,
  softDeadlineExpired,
} from '../../shared/soft-deadline.js';
import { summarizeToolInput } from '../../shared/tool-input-summary.js';
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
 * Inject an advance remaining-round warning into the OpenAI-compatible message
 * history when a {@link pickRoundWarning} threshold is crossed.
 *
 * Extracted from `runTurnInner` to keep that function under the 200-line
 * function ceiling. Fires at most once per threshold per turn (idempotent via
 * `warnState.lastWarnedThreshold`). A no-op when no cap is in effect or no
 * new threshold is crossed.
 */
export function injectRoundWarning(
  priorTurns: import('../messages.js').OpenAIMessage[],
  round: number,
  maxIterations: number,
  warnState: { lastWarnedThreshold: number | undefined },
): void {
  const [warnText, newThreshold] = pickRoundWarning(round, maxIterations, warnState.lastWarnedThreshold);
  if (warnText === null) return;
  warnState.lastWarnedThreshold = newThreshold;
  const lastTurn = priorTurns[priorTurns.length - 1];
  if (lastTurn !== undefined && lastTurn.role === 'tool') {
    // OpenAI tool-result messages are not text-appendable; inject a follow-up user turn.
    priorTurns.push({ role: 'user', content: warnText });
  } else if (lastTurn !== undefined && lastTurn.role === 'user') {
    const content = lastTurn.content;
    if (typeof content === 'string') {
      lastTurn.content = content + '\n\n' + warnText;
    } else if (Array.isArray(content)) {
      (content as Array<{ type: string; text: string }>).push({ type: 'text', text: warnText });
    }
  }
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

  pushUserTurn(ctx, content);

  // Accumulate usage across all tool-loop iterations.
  let accumulatedUsage: ProviderUsage = {
    stopReason: null,
    resultSubtype: 'success',
    isError: false,
  };
  let finalAssistantText = '';
  let finalReasoningText = '';
  let finalReasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content';

  const maxIterations = resolveMaxToolIterations(ctx.opts.config.maxToolUseIterations);
  const softDeadlineMs = ctx.opts.config.softDeadlineMs ?? 0;
  let windDownReason: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | null = null;
  let round = 0;
  // Shared mutable state for advance remaining-round warnings (see pickRoundWarning).
  // One object per turn so each threshold fires exactly once across all rounds.
  const warnState: { lastWarnedThreshold: number | undefined } = { lastWarnedThreshold: undefined };
  let toolCallCount = 0;
  let droppedToolNames: string[] = [];

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

    {
      const roundCalls = finalizedToolCalls(result.state);
      toolCallCount += roundCalls.length;
      const lastCall = roundCalls.at(-1);
      const lastToolName = lastCall?.name;
      let lastCallInput: unknown;
      try {
        lastCallInput = lastCall ? JSON.parse(lastCall.argumentsRaw || '{}') : undefined;
      } catch {
        lastCallInput = undefined;
      }
      const lastToolHeadline = lastCall
        ? `${lastCall.name}${summarizeToolInput(lastCall.name, lastCallInput)}`
        : 'unknown';
      yield {
        type: 'progress',
        progress: {
          taskId,
          description: 'Working',
          summary: `${formatRoundLabel(round, maxIterations)}: ${lastToolHeadline}`,
          lastToolName,
          totalTokens: accumulatedUsage.totalTokens ?? 0,
          toolUses: toolCallCount,
          durationMs: Date.now() - turnStartTime,
        },
        sessionId: ctx.initSessionId,
      };
    }

    injectRoundWarning(ctx.priorTurns, round, maxIterations, warnState);

    if (controller.signal.aborted) {
      ctx.abort.clear(controller);
      yield* finishTurn(ctx, accumulatedUsage, turnStartTime);
      return;
    }

    const roundsSpent = shouldWindDown(round, maxIterations);
    const timeSpent = softDeadlineExpired(turnStartTime, softDeadlineMs);
    if (roundsSpent || timeSpent) {
      windDownReason = roundsSpent ? TOOL_USE_LOOP_CAPPED : SOFT_DEADLINE_WIND_DOWN;
      continue;
    }
  }

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

  // Emit the terminal assistant.message (with truncation notice appended).
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
