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

import type { ProviderEvent } from '../../provider.js';
import type { RunTurnInput } from './types.js';
import { toProviderUsage } from './types.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { resolveTtfbTimeoutMs } from '../shared/first-byte-timeout.js';
import { resolveStallTimeoutMs } from '../shared/stream-stall-timeout.js';
import { resolveMaxToolIterations } from '../shared/tool-loop-cap.js';
import { OVERLOAD_EXHAUSTED, OVERLOAD_EXHAUSTED_NOTICE } from './overload-pause.js';
import { OVERLOAD_MAX_RETRIES, RoundRetryBudget } from './loop/retry-budget.js';
import { handleRoundRetry, type RoundRetryContext } from './loop/round-retry.js';
import { openRound } from './loop/round-request.js';
import { consumeRoundStream } from './loop/stream-consumer.js';
import { runToolRound } from './loop/tool-round.js';
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

    // stopReason === 'tool_use' — dispatch the tools, commit the results, and
    // decide whether the turn keeps going. The whole history mutation contract
    // (assistant push, rollback on throw, tool_result commit) lives inside.
    const round = yield* runToolRound(turnResult, input, turn, maxIterations);
    if (round === 'terminated') return;
  }
  } finally {
    trace.finish(turn.elapsedMs());
  }
}
