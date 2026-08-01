/**
 * Per-turn agentic loop for the `anthropic-direct` provider.
 *
 * Owns the **multi-step tool-use loop within a single user turn**: orchestrates
 * `client.messages.create({...stream: true})` calls, threads each call's raw
 * events through {@link translateMessageStream}, dispatches tool calls via the
 * pluggable {@link ToolDispatcherLike}, accumulates message history (assistant
 * turn + `tool_result` user turn) for the next iteration, sums usage across
 * iterations. Caps tool-use rounds only when `maxToolUseIterations` is
 * explicitly set to a positive value; the default ({@link
 * DEFAULT_MAX_TOOL_USE_ITERATIONS} = 0) means "no cap" — terminate naturally
 * when the model stops emitting tool_use blocks. Callers that want a hard
 * ceiling pass `maxToolUseIterations` per turn.
 *
 * The caller (query.ts) owns the **multi-turn outer loop** across user inputs,
 * the messages array's lifetime, and `session.init` synthesis. This module is
 * a pure async generator over `ProviderEvent`s with no module-scope state.
 *
 * Mutation contract: `runTurn` mutates `input.messages` in place — appending
 * the assistant turn's content blocks and a follow-up user turn carrying
 * `tool_result` blocks for every tool-use round. Callers must read
 * `input.messages` AFTER the generator returns so the next user turn sees the
 * full history.
 *
 * @module agent/providers/anthropic-direct/loop
 */

import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import type { RunTurnInput, ToolCall, ToolResult } from './types.js';
import { toProviderUsage } from './types.js';
import { translateMessageStream } from './translate.js';
import { emitToolCall, emitSessionPhase } from '../../trace/emit.js';
import { extractRawToolInput } from '../../facets/raw-input.js';
import { resolveTtfbTimeoutMs } from '../shared/first-byte-timeout.js';
import { resolveStallTimeoutMs } from '../shared/stream-stall-timeout.js';
import { summarizeToolInput } from '../shared/tool-input-summary.js';
import {
  TOOL_USE_LOOP_CAPPED,
  WIND_DOWN_NOTE,
  resolveMaxToolIterations,
  shouldWindDown,
} from '../shared/tool-loop-cap.js';
import {
  buildToolCallCompletedPayload,
  buildToolCallStartedPayload,
} from '../shared/tool-call-trace.js';
import { DENIAL_BREAKER_FAILURE_CLASS } from '../../tools/denial-circuit-breaker.js';
import { DenialCircuitBreakerError } from '../../../utils/errors.js';
import { OVERLOAD_EXHAUSTED, OVERLOAD_EXHAUSTED_NOTICE } from './overload-pause.js';
import { OVERLOAD_MAX_RETRIES, RoundRetryBudget } from './loop/retry-budget.js';
import { handleRoundRetry, type RoundRetryContext } from './loop/round-retry.js';
import { openRound } from './loop/round-request.js';
import { consumeRoundStream } from './loop/stream-consumer.js';
import { emitNonToolUseTerminal } from './loop/turn-terminal.js';
import { TurnAccumulator } from './loop/turn-accumulator.js';
import { TurnTrace } from './loop/turn-trace.js';

// Re-exported from the provider-neutral `shared/tool-loop-cap.ts` (single
// source of truth shared with openai-compatible). Kept exported here so
// existing importers (loop.test.ts) resolve unchanged.
export { DEFAULT_MAX_TOOL_USE_ITERATIONS } from '../shared/tool-loop-cap.js';

/**
 * Run one user turn through the model + tool dispatcher loop. Yields
 * `ProviderEvent`s as the model streams; on completion of the turn (the model
 * stops with anything other than `tool_use`, or the iteration cap is hit),
 * yields a final `turn.completed` event with summed usage and returns.
 *
 * The caller is responsible for: (a) appending the new user `MessageParam` to
 * `input.messages` BEFORE calling `runTurn`, and (b) reading the mutated
 * `input.messages` array AFTER `runTurn` returns so the next user turn sees
 * the full history (assistant turn + `tool_result` rounds, if any).
 *
 * Errors from `messages.create` (network, auth) are yielded as `error`
 * events and terminate the turn. Errors from the dispatcher are absorbed
 * into the synthesized `tool_result` block as `is_error: true` so the model
 * can recover. Aborts yield `turn.completed` with accumulated usage so
 * downstream consumers always receive a terminal event.
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<ProviderEvent, void, void> {
  const maxIterations = resolveMaxToolIterations(input.maxToolUseIterations);

  // Three collaborators, three lifetimes — see each class for its reset
  // discipline. `turn` survives the whole turn, `retry` is released at every
  // clean round boundary, `trace` outlives both because its abort listener can
  // fire during any phase.
  const turn = new TurnAccumulator();
  const retry = new RoundRetryBudget();
  // Both TTFB re-drive sites (connection-phase and mid-stream) and both backoff
  // classes share one budget instance — see RoundRetryBudget's contract.
  const retryContext = (requestStartedAt: number): RoundRetryContext => ({
    input,
    turn,
    retry,
    requestStartedAt,
  });

  // Per-round time-to-first-token stall bound (issue #583). A degrading upstream
  // call that never streams a first CONTENT token (text/thinking delta or
  // tool_use — message_start + pings do NOT count) is aborted at this bound and
  // retried ONCE per round, then surfaces as an error — instead of hanging up to
  // the SDK's ~10-min default. `0` (or AFK_MODEL_TTFB_TIMEOUT_MS=0) disables it.
  // The single retry reuses the createWithRetry attempt budget model so it
  // cannot stack on top of the overload backoff into a longer worst case.
  const ttfbTimeoutMs = resolveTtfbTimeoutMs();
  // Per-round POST-first-byte stall bound (issue #762). The TTFB bound above is
  // cleared by the first content token, so before this a stream that stalled
  // mid-flight had NO bound of any kind: two real sessions hung 38.9 and 63.5
  // minutes and sealed `incomplete: true` (the process-exit backstop) with no
  // `loop_end` and no `closure` at all. This watchdog is progress-AWARE — every
  // translated output event re-arms it — so a legitimately long, actively
  // streaming round is never cut off (the invariant loop.ttfb.test.ts pins),
  // while a round that goes silent for the whole window dies loudly with a real
  // terminal error. `0` (or AFK_MODEL_STALL_TIMEOUT_MS=0) disables it.
  const stallTimeoutMs = resolveStallTimeoutMs();

  // Witness layer: brackets the turn with loop_start / loop_end and owns the
  // interrupt→halt latency stamp. loop_end fires from the generator's finally
  // block so all exit paths — abort, error, clean end-of-turn, capped — are
  // covered without per-site annotation.
  const trace = new TurnTrace(input.signal, input.traceWriter);

  try {
  while (true) {
    if (input.signal.aborted) {
      yield {
        type: 'turn.completed',
        usage: turn.terminalUsage(),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    const opened = yield* openRound({ input, turn, retry, ttfbTimeoutMs, stallTimeoutMs });

    // The connection phase already yielded this turn's terminal event.
    if (opened.kind === 'terminated') return;

    if (opened.kind === 'retry-ttfb') {
      // Connection-phase TTFB timeout: re-drive once. Shares the once-per-round
      // allowance with the mid-stream TTFB path via the same retry handler.
      const redrive = yield* handleRoundRetry('ttfb', retryContext(opened.requestStartedAt));
      if (redrive === 'terminated') return;
      continue;
    }

    const { events, ttfb, stall, requestStartedAt } = opened;

    const outcome = yield* consumeRoundStream({
      events,
      input,
      turn,
      retry,
      ttfb,
      stall,
      stallTimeoutMs,
      requestStartedAt,
    });

    // The stream phase already yielded this turn's terminal event.
    if (outcome.kind === 'terminated') return;

    if (outcome.kind === 'retry') {
      const redrive = yield* handleRoundRetry(outcome.reason, retryContext(requestStartedAt));
      if (redrive === 'terminated') return;
      continue;
    }

    // Invariant: this round is past every retry decision, so all three budgets
    // are spent — restore the full allowance for the next tool-use round.
    // Reset here, ABOVE the terminal paths below, so the "each tool-use round
    // starts with a fresh budget" rule holds uniformly. The translator-error
    // and null-result paths return (so the reset is moot for them today), but
    // placing it above them makes the invariant unconditional and survives a
    // future refactor that turns a terminal path into a `continue`. A round
    // only reaches here after a clean first byte, so the TTFB allowance is
    // never released on the failing attempt of the same round. See
    // RoundRetryBudget.reset for the per-field contract.
    retry.reset();

    // Invariant: this branch must come BEFORE the `translatorErrored` /
    // `turnResult === null` terminals below, and must emit exactly ONE terminal
    // event. Ordering is load-bearing in both directions: it sits below the
    // retry `continue`s (an exhausted round is never also a retried round) and
    // above the generic terminals (which would otherwise re-classify it).
    //
    // Turn preservation (#762): emit a CLEAN `turn.completed` so the session's
    // stream consumer maps it to `done` → `turnCount++`, committing the turn and
    // leaving the accumulated history in `input.messages` resumable via
    // `afk --resume <sessionId>`. Previously this path yielded a raw `error`,
    // which set `sawProviderError` and sealed the session `failed` with
    // `finalTurnCount: 0` — every prior turn discarded.
    //
    // The failure is still surfaced, twice over: the OVERLOAD_EXHAUSTED
    // stopReason drives an `abort` closure + `failed` seal downstream, and the
    // notice replaces the raw `{"type":"overloaded_error"}` SSE envelope
    // operators were misreading as a TypeScript error.
    //
    // Contract: the notice is NOT appended to THIS turn's `input.messages`, so
    // it never re-enters the request that is failing. It is NOT invisible to the
    // model, though — `session/stream-consumer.ts` materializes every non-empty
    // `assistant.message` into `conversationHistory`, which threads back as
    // model context on the next turn and on `--resume`. Same shape as the
    // `stop_reason: 'refusal'` notice below. Read as "not retried into the dead
    // request", not "operator-only".
    if (outcome.kind === 'overload-exhausted') {
      void emitSessionPhase(input.traceWriter, {
        phase: 'rate_limit',
        metadata: {
          reason: 'overloaded',
          source: 'mid-stream',
          attempt: OVERLOAD_MAX_RETRIES,
          exhausted: true,
        },
      });
      yield {
        type: 'assistant.message',
        text: OVERLOAD_EXHAUSTED_NOTICE,
        sessionId: input.ctx.sessionId,
      };
      yield {
        type: 'turn.completed',
        usage: turn.withDuration({ ...turn.usage, stopReason: OVERLOAD_EXHAUSTED }),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    if (outcome.kind === 'translator-errored') {
      // Error event was already yielded. On an abort (interrupt/close), emit
      // turn.completed with accumulated usage so callers can account for
      // partial costs. On a real stream error, skip turn.completed so cost
      // is not double-counted and state is not incorrectly advanced.
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: turn.terminalUsage(),
          sessionId: input.ctx.sessionId,
        };
      }
      return;
    }
    const turnResult = outcome.turnResult;
    if (turnResult === null) {
      // Stream ended without a turn-result; treat as a clean end-of-turn
      // with the usage we already have.
      yield {
        type: 'turn.completed',
        usage: turn.terminalUsage(),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    turn.addRoundUsage(
      toProviderUsage(turnResult.usage, turnResult.stopReason, input.model),
    );
    // Surface per-round cumulative usage so getContextUsage() reflects mid-turn
    // growth on the status line. Fires on every round including the terminal
    // end_turn; the authoritative duration-stamped value is still set on
    // turn.completed immediately after. Synchronous, never awaited.
    input.onUsageProgress?.(turn.usage);

    if (turnResult.stopReason !== 'tool_use') {
      yield* emitNonToolUseTerminal(turnResult, input, turn);
      return;
    }

    // stopReason === 'tool_use' — push the assistant turn into history,
    // dispatch every tool_use block, then assemble the tool_result user turn.
    //
    // Rollback contract: capture the pre-push length so any throw between
    // here and the final `input.messages.push(toolResultTurn)` below can
    // splice the orphaned assistant message back out. Without this, an
    // unexpected throw inside `executeBatch` / `execute` (one not absorbed
    // into an `is_error: true` ToolResult) would leave history terminating
    // in an unmatched `tool_use` — every subsequent API call would 400.
    const messagesRollbackIdx = input.messages.length;
    input.messages.push({
      role: 'assistant',
      content: turnResult.assistantBlocks,
    });
    try {

    // Accumulate the cumulative tool-call tally BEFORE dispatch so the progress
    // emit below reports calls-so-far including this round's batch. One round
    // can carry N parallel tool_use blocks, so this advances by the block count,
    // not by 1.
    turn.toolCallCount += turnResult.toolUseBlocks.length;

    // Build all tool calls and emit start events upfront.
    const calls: ToolCall[] = [];
    // Per-call start timestamps keyed by toolUseId so the completed
    // trace event can carry an accurate `durationMs`. Lives within this
    // loop iteration only — the next iteration starts fresh.
    const startTimes = new Map<string, number>();
    for (const block of turnResult.toolUseBlocks) {
      calls.push({
        id: block.id,
        name: block.name,
        input: block.input,
        signal: input.signal,
      });
      const now = Date.now();
      startTimes.set(block.id, now);
      // Witness layer: tool_call.started fires BEFORE dispatch so even a
      // crashing tool leaves evidence that it was attempted. Fire-and-
      // forget — emitToolCall swallows writer errors internally.
      void emitToolCall(
        input.traceWriter,
        buildToolCallStartedPayload({
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          subagentId: input.subagentId,
        }),
      );
      yield {
        type: 'tool.use.start',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: summarizeToolInput(block.name, block.input),
        toolInputRaw: extractRawToolInput(block.input),
        sessionId: input.ctx.sessionId,
      };
    }

    if (input.signal.aborted) {
      const abortedResults: ToolResultBlockParam[] = calls.map((call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content: 'Tool call aborted',
        is_error: true,
      }));
      input.messages.push({ role: 'user', content: abortedResults as ContentBlockParam[] });
      yield {
        type: 'turn.completed',
        usage: turn.terminalUsage(),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    // Dispatch: batch (parallel for safe tools) or sequential fallback.
    let results: ToolResult[];
    if (input.toolDispatcher.executeBatch) {
      try {
        results = await input.toolDispatcher.executeBatch(calls);
      } catch (err) {
        results = calls.map(() => ({
          content: `Tool batch execution failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true as const,
        }));
      }
    } else {
      results = [];
      for (const call of calls) {
        if (input.signal.aborted) {
          results.push({ content: 'Tool call aborted', isError: true });
          continue;
        }
        try {
          results.push(await input.toolDispatcher.execute(call));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ content: `Tool execution threw: ${message}`, isError: true });
        }
      }
    }

    // Yield results and build tool_result blocks in original order.
    const toolResultBlocks: ToolResultBlockParam[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const result = results[i]!;

      // Witness layer: tool_call.completed pairs with the .started event
      // emitted above. `truncated` is now sourced from the handler's
      // structured `ToolResult.truncated` flag — set by `handlers/bash.ts`
      // and `handlers/grep.ts` whenever their byte cap is hit. The
      // sentinel-substring fallback survives for third-party tool handlers
      // that emit the `[output truncated …]` sentinel without setting the
      // structured flag (back-compat). Fire-and-forget to keep the loop
      // iteration cheap.
      const startedAt = startTimes.get(call.id);
      const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : 0;
      const truncated = result.truncated === true || result.content.includes('[output truncated');
      void emitToolCall(
        input.traceWriter,
        buildToolCallCompletedPayload({
          toolUseId: call.id,
          name: call.name,
          result,
          truncated,
          durationMs,
          subagentId: input.subagentId,
        }),
      );

      yield {
        type: 'tool.output',
        toolUseId: call.id,
        toolName: call.name,
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(result.incomplete === true ? { incomplete: true } : {}),
        ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
        ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
          ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
          : {}),
        sessionId: input.ctx.sessionId,
      };

      // Sidecar render-only event for file-mutation tools. Travels on a
      // separate event variant — the `toolResultBlocks.push()` call below
      // cannot reference `result.render` (it's not in scope), so a future
      // refactor cannot accidentally leak diff payloads into the model's
      // `tool_result` content. This is the structural correctness invariant
      // for the diff render channel.
      if (result.render?.diff) {
        yield {
          type: 'tool.diff',
          toolUseId: call.id,
          diff: result.render.diff,
          sessionId: input.ctx.sessionId,
        };
      }

      // Destructure only the model-facing fields so `result.render` is
      // structurally unreachable at this call site — not merely excluded by
      // convention. This makes the isolation load-bearing rather than
      // documentation-only. `image` is the ONE structured field that IS
      // model-facing: when set it becomes an `image` content block alongside
      // the text. `render` remains excluded.
      const { content: resultContent, isError: resultIsError, image: resultImage } = result;
      // When a tool returns an image (e.g. browser_screenshot), emit it as an
      // image block followed by the text summary. The handler keeps the text
      // non-empty so providers that drop the image still see useful context.
      const toolResultContent: ToolResultBlockParam['content'] =
        resultImage !== undefined
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: resultImage.mediaType,
                  data: resultImage.data,
                },
              },
              ...(resultContent.length > 0
                ? [{ type: 'text' as const, text: resultContent }]
                : []),
            ]
          : resultContent;
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultContent,
        ...(resultIsError === true ? { is_error: true } : {}),
      });
    }

    const toolResultTurn: MessageParam = {
      role: 'user',
      content: toolResultBlocks as ContentBlockParam[],
    };
    input.messages.push(toolResultTurn);

    // Denial circuit breaker (#546): the dispatcher tagged a result
    // `denial-breaker` after a forked child hit N consecutive path-approval
    // read denials with no progress. Surface it as a LOUD `error` event — never
    // a silent partial — so the shared subagent handle rethrows it into a
    // structured `buildResultFromError` failure the parent can act on (mirrors
    // the TimeoutError teardown). History is already consistent here (assistant
    // `tool_use` + matching `tool_result` blocks both pushed above), so
    // returning is safe; the fork is done. A dispatcher throw would instead be
    // swallowed by the executeBatch/execute catch above and the loop would keep
    // spinning — which is the exact failure this breaker exists to prevent.
    const denialTrip = results.find((r) => r.failureClass === DENIAL_BREAKER_FAILURE_CLASS);
    if (denialTrip) {
      yield { type: 'error', error: new DenialCircuitBreakerError(denialTrip.content) };
      return;
    }
    } catch (err) {
      // Rollback the orphaned assistant `tool_use` push above so the next
      // turn's API call does not 400 with "tool_use ids were found without
      // tool_result blocks immediately after". Any path that reached the
      // matching `input.messages.push(toolResultTurn)` above (or the
      // earlier aborted-results push at the signal-aborted gate) returned
      // from inside the try with history already consistent, so they do
      // not enter this catch. Re-throw so the outer query-level handler
      // still surfaces the error.
      input.messages.splice(messagesRollbackIdx);
      throw err;
    }

    turn.iterations += 1;

    const lastTool = turnResult.toolUseBlocks[turnResult.toolUseBlocks.length - 1];
    // Semantic summary: name the tool AND its most informative argument
    // (path / command / query via summarizeToolInput) so the progress banner
    // carries real signal — `bash git show f7f0a37…` instead of the old
    // `Iteration 11: used bash`, which conveyed nothing after round 2.
    // `description` stays STABLE across ticks for this task id (the banner
    // dedupes line 0 on commit); the per-tick signal lives in `summary`.
    const lastToolHeadline = lastTool
      ? `${lastTool.name}${summarizeToolInput(lastTool.name, lastTool.input)}`
      : 'unknown';
    yield {
      type: 'progress',
      progress: {
        taskId: turn.taskId,
        description: 'Working',
        summary: `round ${turn.iterations}: ${lastToolHeadline}`,
        lastToolName: lastTool?.name,
        totalTokens: turn.usage.totalTokens ?? 0,
        // Contract: `toolUses` is the cumulative COUNT OF TOOL CALLS so far in
        // this turn (not the round number), so downstream formatToolCallStat
        // renders "N tool calls" truthfully even when a round batched parallel
        // calls. The `summary` above legitimately names the ROUND — leave it.
        toolUses: turn.toolCallCount,
        durationMs: Date.now() - turn.startedAt,
      },
      sessionId: input.ctx.sessionId,
    };
    if (turn.capReached) {
      // The wind-down round (tools stripped) still came back as `tool_use` —
      // only reachable if the model emits a tool call against an empty toolset.
      // Honor the cap with a hard stop rather than looping unbounded.
      yield {
        type: 'turn.completed',
        usage: turn.withDuration({ ...turn.usage, stopReason: TOOL_USE_LOOP_CAPPED }),
        sessionId: input.ctx.sessionId,
      };
      return;
    }
    if (shouldWindDown(turn.iterations, maxIterations)) {
      // Cap reached. Instead of cutting the turn off HERE — which ends it with
      // no final assistant message and reads as a silent hang — run ONE more
      // round with tools stripped (params build above) so the model can
      // synthesize a final answer from what it gathered. Append a brief note to
      // the tool_result turn just pushed so the model knows why its tools are
      // gone. `turn.capReached` guarantees this fires at most once; the guard above
      // hard-stops if the wind-down round pathologically emits another tool_use.
      const lastMsg = input.messages[input.messages.length - 1];
      if (lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({ type: 'text', text: WIND_DOWN_NOTE });
      }
      turn.capReached = true;
      continue;
    }
  }
  } finally {
    trace.finish(turn.elapsedMs());
  }
}
