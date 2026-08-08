/**
 * Per-turn agentic loop for the `anthropic-direct` provider.
 *
 * Owns the **multi-step tool-use loop within a single user turn**. This file is
 * the orchestrator only: it holds the round `while` loop and dispatches each
 * phase to a module in `./loop/`. The caller (query.ts) owns the **multi-turn
 * outer loop** across user inputs, the messages array's lifetime, and
 * `session.init` synthesis.
 *
 * Round phases, in execution order:
 *
 * | Module                    | Responsibility                                  |
 * |---------------------------|-------------------------------------------------|
 * | `loop/round-request`      | params build, cache breakpoint, connection retry, watchdog arming |
 * | `loop/throttle-signals`   | live `rate_limit` events while the create is parked |
 * | `loop/stream-consumer`    | drive translate, yield events, classify the round end |
 * | `loop/round-retry`        | backoff + signalling for a re-driven round      |
 * | `loop/turn-terminal`      | the non-`tool_use` exit paths                   |
 * | `loop/tool-round`         | tool dispatch, result commit, rollback, epilogue |
 *
 * State is held in three collaborators with three distinct lifetimes —
 * `TurnAccumulator` (whole turn), `RoundRetryBudget` (released each clean
 * round), `TurnTrace` (spans every phase, torn down in `finally`). Which state
 * survives a `continue` is answerable by reading a type; see each class.
 *
 * Cap semantics: tool-use rounds are capped only when `maxToolUseIterations` is
 * explicitly set to a positive value. The default (0) means "no cap" —
 * terminate naturally when the model stops emitting tool_use blocks. On
 * reaching the cap the loop runs ONE final wind-down round with tools stripped
 * so the model produces a real answer instead of stopping silently.
 *
 * Mutation contract: `runTurn` mutates `input.messages` in place — appending
 * the assistant turn's content blocks and a follow-up user turn carrying
 * `tool_result` blocks for every tool-use round. Callers must read
 * `input.messages` AFTER the generator returns so the next user turn sees the
 * full history.
 *
 * Invariant: every phase that yields a TERMINAL event returns an outcome saying
 * so, and this file returns without yielding again. Emitting a second terminal
 * would strand a consumer that breaks on the first one.
 *
 * History: the retry-class rationale (mid-stream overload, clean-close
 * re-drive, TTFB and stall bounds) and the decomposition record for this module
 * live in docs/anthropic-direct-loop.md.
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
import {
  OVERLOAD_MAX_RETRIES,
  RoundRetryBudget,
  ttfbAttemptTimeoutMs,
} from './loop/retry-budget.js';
import { handleRoundRetry, type RoundRetryContext } from './loop/round-retry.js';
import { openRound } from './loop/round-request.js';
import { consumeRoundStream } from './loop/stream-consumer.js';
import { runToolRound } from './loop/tool-round.js';
import { emitNonToolUseTerminal } from './loop/turn-terminal.js';
import { TurnAccumulator } from './loop/turn-accumulator.js';
import { TurnTrace } from '../shared/turn-trace.js';

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

  // Per-ATTEMPT time-to-first-token stall bound (issue #583). A degrading
  // upstream call that never streams a first CONTENT token (text/thinking delta
  // or tool_use — message_start + pings do NOT count) is aborted at this bound
  // and re-driven while the round's counted TTFB budget holds allowance, then
  // surfaces as an error — instead of hanging up to the SDK's ~10-min default.
  // `0` (or AFK_MODEL_TTFB_TIMEOUT_MS=0) disables it.
  //
  // The env var stays the per-ROUND budget; `ttfbAttemptTimeoutMs` divides it
  // into TTFB_MAX_ATTEMPTS shorter attempts so the worst case is bounded by the
  // pre-count regime's (2 × configured) for EVERY configured value — see the
  // arithmetic Invariant in loop/retry-budget.ts.
  const ttfbTimeoutMs = ttfbAttemptTimeoutMs(resolveTtfbTimeoutMs());
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
  const trace = new TurnTrace(input.signal, input.traceWriter, 'anthropic-direct');

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
      // Connection-phase TTFB timeout: re-drive. Shares ONE counted per-round
      // allowance with the mid-stream TTFB path via the same retry handler, so a
      // round that alternates between the two stall shapes still gets exactly
      // TTFB_MAX_ATTEMPTS first-byte attempts in total.
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
      toProviderUsage(turnResult.usage, turnResult.stopReason, input.model, input.fastMode ? 'fast' : undefined),
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
