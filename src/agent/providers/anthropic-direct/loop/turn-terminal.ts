/**
 * Terminal path for a round that ended WITHOUT requesting tools.
 *
 * Handles the three ways a turn finishes on its own: a content-safety refusal,
 * a normal text completion, and an empty completion. Every branch is terminal —
 * the caller returns immediately after delegating here.
 *
 * Also exports two helpers used by the `runTurn` orchestrator to handle the
 * overload-exhausted and stream-terminal outcomes without bloating that
 * function past the 200-line ceiling:
 *
 *  - `emitOverloadExhausted` — shared body for the connection-phase and
 *    mid-stream overload-budget-exhausted branches (issue #762).
 *  - `handleStreamTerminals` — translator-errored and null-result exits.
 *
 * All helpers take explicit parameters; no closures over loop-local state.
 *
 * @module agent/providers/anthropic-direct/loop/turn-terminal
 */

import type { TraceSink } from '../../../trace/writer.js';
import type { ProviderEvent } from '../../../provider.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { isTruncationStopReason, truncationNotice } from '../../shared/truncation.js';
import { OVERLOAD_EXHAUSTED, OVERLOAD_EXHAUSTED_NOTICE } from '../overload-pause.js';
import { OVERLOAD_MAX_RETRIES } from './retry-budget.js';
import type { RunTurnInput, TurnResult } from '../types.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/** Text at or below this length is also offered as a `suggestion`. */
const SUGGESTION_MAX_LENGTH = 200;

/**
 * Emit the closing events for a non-`tool_use` stop reason, pushing the
 * assistant turn into history along the way.
 *
 * Synchronous: nothing here awaits, so it is a plain generator rather than an
 * async one.
 */
export function* emitNonToolUseTerminal(
  turnResult: TurnResult,
  input: RunTurnInput,
  turn: TurnAccumulator,
): Generator<ProviderEvent, void, void> {
  // Invariant: stop_reason 'refusal' is Anthropic's content-safety stop — the
  // model declined and the API returns an assistant turn with (almost always)
  // NO content. The generic empty-completion path below would emit nothing and
  // end the turn SILENTLY, indistinguishable from a hang: the operator sees a
  // turn that "stopped" with no answer and no reason. Worse, the flagged
  // content stays in the conversation, so every later turn refuses identically
  // — the reported "it stopped and I can't send anything else".
  //
  // Issue #970: migrate from `assistant.message` to the dedicated `notice`
  // channel. The refusal operator message was always display-only (never pushed
  // to model history), but riding on `assistant.message` meant it ended up in
  // `conversationHistory` (stream-consumer.ts pushes every non-empty
  // assistant.message there). The `notice` channel renders on all live surfaces
  // and is explicitly excluded from conversationHistory and from `finalMessage`
  // capture in handle.ts — matching the "display-only" claim the comment above
  // has always made but that `assistant.message` could not fully honour.
  //
  // If the model returned partial text alongside the refusal, yield it as a
  // real assistant.message first so the content is visible and enters history
  // in the normal way (it is genuine model output). The notice then follows as
  // a separate operator-facing annotation.
  if (turnResult.stopReason === 'refusal') {
    if (turnResult.text.length > 0) {
      yield {
        type: 'assistant.message',
        text: turnResult.text,
        sessionId: input.ctx.sessionId,
      };
    }
    yield {
      type: 'notice',
      text:
        'The model stopped with a content-safety refusal (stop_reason: "refusal") and returned no output. ' +
        "This is Anthropic's safety system declining the request — not an afk error. " +
        'Because the flagged context stays in the conversation, follow-up messages will likely be refused the same way; ' +
        'rephrase the request or start a fresh session to continue.',
      kind: 'refusal' as const,
      sessionId: input.ctx.sessionId,
    };
    yield {
      type: 'turn.completed',
      usage: turn.terminalUsage(),
      sessionId: input.ctx.sessionId,
    };
    return;
  }

  // #952: a `max_tokens` truncation is otherwise invisible on every live surface
  // (REPL, Telegram, chat) — the closure reason never leaves the trace stream, so
  // a partial turn is indistinguishable from a clean completion, and the worst
  // case (a tool call cut mid-arguments, stripped below and never dispatched)
  // reads as the agent giving up mid-task. The dropped-tool names come from
  // `toolUseBlocks` (the exact blocks the strip below removes).
  //
  // The notice is APPENDED to the partial-text message below (not yielded as a
  // second `assistant.message`): last-wins consumers — the non-streaming
  // `sendMessage()` path and a subagent's final-message capture — keep only
  // the LAST assistant message of a turn, so two messages here would silently
  // discard the real answer and surface only the warning.
  //
  // Invariant (#960): the notice rides ONLY on an existing partial-text
  // message — a turn that produced NO text emits no `assistant.message` at
  // all, and must keep emitting none. A textless turn has to stay textless all
  // the way downstream, because "the model produced nothing" is detected by the
  // ABSENCE of a message event, not by any positive signal:
  //
  //   stream-consumer.ts `case 'assistant.message'` gates on `if (event.text)`,
  //   so a textless turn yields no `{type:'message'}` OutputEvent; `handle.ts`
  //   therefore leaves `finalMessage` unset, falls past its `if (finalMessage)`
  //   return, and reaches the ZERO-OUTPUT branch that stamps STREAM_INCOMPLETE
  //   and THROWS — which is what makes a zero-output child resolve `failed`
  //   instead of a false `succeeded`, and what lets `stream-cut-retry.ts`
  //   re-dispatch a read-only child that died having produced nothing.
  //
  // Emitting a standalone notice here would make that whole chain unreachable:
  // the notice is non-empty, so `finalMessage` gets set, the throw never runs,
  // and a truncated child returns to its parent as a SUCCESS whose entire
  // content is this warning — zero findings, dressed as an answer. `handle.ts`
  // names `max_tokens` explicitly as a stop reason that reaches its zero-output
  // branch "via an empty-text turn the stream consumer drops"; that assumption
  // is load-bearing and this branch must not break it.
  //
  // Issue #970: a textless truncation previously stayed invisible on every live
  // surface (REPL, Telegram, chat) — unchanged from before #952 and explicitly
  // accepted as a deliberate consequence there. Now that the `notice` channel
  // exists, emit it for the textless case so the operator sees the truncation
  // without the event impersonating model output or touching conversationHistory.
  //
  // Invariant (#960): the textless-turn invariant is PRESERVED. A notice is NOT
  // an `assistant.message`, so `stream-consumer.ts case 'notice':` returns a
  // `{type:'notice'}` OutputEvent — NOT a `{type:'message'}`. The `handle.ts`
  // `finalMessage` capture reads only `{type:'message'}` events, so a textless
  // turn still leaves `finalMessage` unset, still reaches the ZERO-OUTPUT branch
  // that stamps STREAM_INCOMPLETE and throws, and still resolves as `failed`.
  // The retry predicate, `canRedispatch`, and `sideEffectFree` logic are
  // untouched — this is additive visibility only. (#724 durability is out of
  // scope for this PR.)
  const truncationText = isTruncationStopReason(turnResult.stopReason)
    ? truncationNotice(turnResult.toolUseBlocks.map((b) => b.name), turnResult.stopReason)
    : null;

  if (turnResult.text.length > 0) {
    yield {
      type: 'assistant.message',
      text: truncationText ? `${turnResult.text}\n\n${truncationText}` : turnResult.text,
      sessionId: input.ctx.sessionId,
    };
    // The suggestion always mirrors the model's own text, never the appended
    // notice — it feeds a quick-reply candidate, not an operator warning.
    if (turnResult.text.length <= SUGGESTION_MAX_LENGTH) {
      yield {
        type: 'suggestion',
        suggestion: turnResult.text,
        sessionId: input.ctx.sessionId,
      };
    }
  } else if (truncationText !== null) {
    // Textless truncation: the model produced no output before hitting the
    // output-token cap. Emit via the display-only `notice` channel so the
    // operator sees the event without it becoming a terminal message. The
    // zero-output detection chain is unaffected — `notice` is not a
    // `{type:'message'}` and `finalMessage` in handle.ts stays unset.
    yield {
      type: 'notice',
      text: truncationText,
      kind: 'truncation' as const,
      sessionId: input.ctx.sessionId,
    };
  }

  // Anthropic API contract: every `tool_use` block in assistant content MUST be
  // followed by a matching `tool_result` block in the next user message. When
  // stopReason !== 'tool_use', we are exiting the turn WITHOUT dispatching
  // tools — any tool_use blocks the translator collected (e.g. a tool_use
  // truncated by `max_tokens`, or one paired with a `pause_turn` stop) would
  // become orphans the moment they hit history. Strip them before pushing so
  // the next user turn cannot 400 with "tool_use ids were found without
  // tool_result blocks immediately after".
  const safeAssistantBlocks = turnResult.assistantBlocks.filter((b) => b.type !== 'tool_use');
  if (safeAssistantBlocks.length > 0) {
    input.messages.push({ role: 'assistant', content: safeAssistantBlocks });
  }
  // Journal commit point: the turn's final assistant message.
  input.journalSync?.sync(input.messages);

  yield {
    type: 'turn.completed',
    // On a wind-down round the model ends naturally with `end_turn`, but the
    // turn as a whole WAS cut short by a spent budget — preserve that signal
    // for closure classification + telemetry while still delivering the model's
    // synthesized final message above. `windDownReason` names WHICH budget
    // (rounds vs. wall-clock) so the two are never conflated downstream.
    usage: turn.withDuration(
      turn.windDownReason !== null
        ? { ...turn.usage, stopReason: turn.windDownReason }
        : turn.usage,
    ),
    sessionId: input.ctx.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Overload-exhausted terminal (shared by connection-phase and mid-stream)
// ---------------------------------------------------------------------------

/**
 * Emit the `rate_limit` trace phase, the operator-visible notice, and the
 * clean `turn.completed` for an overload-budget-exhausted round.
 *
 * Extracted so the two call-sites in `runTurn` (connection-phase and
 * mid-stream) share one implementation and the orchestrator stays under the
 * 200-line ceiling. All parameters are explicit — no closures.
 *
 * Contract: the caller MUST `return` immediately after `yield*`-ing this
 * generator. The terminal event is emitted here; a second one would violate
 * the single-terminal-per-turn invariant.
 */
export function* emitOverloadExhausted(
  source: 'connection-phase' | 'mid-stream',
  traceWriter: TraceSink | undefined,
  sessionId: string,
  turn: TurnAccumulator,
): Generator<ProviderEvent, void, void> {
  void emitSessionPhase(traceWriter, {
    phase: 'rate_limit',
    metadata: {
      reason: 'overloaded',
      source,
      attempt: OVERLOAD_MAX_RETRIES,
      exhausted: true,
    },
  });
  yield {
    type: 'assistant.message',
    text: OVERLOAD_EXHAUSTED_NOTICE,
    sessionId,
  };
  yield {
    type: 'turn.completed',
    usage: turn.withDuration({ ...turn.usage, stopReason: OVERLOAD_EXHAUSTED }),
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// Stream-terminal exits (translator-errored and null turn-result)
// ---------------------------------------------------------------------------

/**
 * Handle the two stream-terminal outcomes that follow a clean-streamed round:
 * `translator-errored` and a null `turnResult`.
 *
 * Returns `true` when a terminal was emitted (caller must `return`), `false`
 * when neither condition matched (caller continues processing).
 *
 * Contract: this generator yields AT MOST ONE terminal event — either the
 * `turn.completed` on an aborted translator error, or the `turn.completed`
 * for a null result. The non-aborted translator-error path yields nothing
 * (the error event was already yielded upstream).
 */
export function* handleStreamTerminals(
  outcomeKind: 'translator-errored' | 'streamed',
  turnResult: TurnResult | null,
  signal: AbortSignal,
  sessionId: string,
  turn: TurnAccumulator,
): Generator<ProviderEvent, boolean, void> {
  if (outcomeKind === 'translator-errored') {
    // Error event was already yielded. On an abort (interrupt/close), emit
    // turn.completed with accumulated usage so callers can account for
    // partial costs. On a real stream error, skip turn.completed so cost
    // is not double-counted and state is not incorrectly advanced.
    if (signal.aborted) {
      yield {
        type: 'turn.completed',
        usage: turn.terminalUsage(),
        sessionId,
      };
    }
    return true;
  }
  if (turnResult === null) {
    // Stream ended without a turn-result; treat as a clean end-of-turn
    // with the usage we already have.
    yield {
      type: 'turn.completed',
      usage: turn.terminalUsage(),
      sessionId,
    };
    return true;
  }
  return false;
}
