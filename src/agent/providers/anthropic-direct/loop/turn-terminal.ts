/**
 * Terminal path for a round that ended WITHOUT requesting tools.
 *
 * Handles the three ways a turn finishes on its own: a content-safety refusal,
 * a normal text completion, and an empty completion. Every branch is terminal —
 * the caller returns immediately after delegating here.
 *
 * @module agent/providers/anthropic-direct/loop/turn-terminal
 */

import type { ProviderEvent } from '../../../provider.js';
import { isTruncationStopReason, truncationNotice } from '../../shared/truncation.js';
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
  // — the reported "it stopped and I can't send anything else". Surface an
  // explicit, display-only notice (NOT pushed to history — it is
  // operator-facing, not model context) so the refusal is legible and the
  // operator can rephrase or start a fresh session.
  if (turnResult.stopReason === 'refusal') {
    yield {
      type: 'assistant.message',
      text:
        turnResult.text.length > 0
          ? turnResult.text
          : 'The model stopped with a content-safety refusal (stop_reason: "refusal") and returned no output. ' +
            "This is Anthropic's safety system declining the request — not an afk error. " +
            'Because the flagged context stays in the conversation, follow-up messages will likely be refused the same way; ' +
            'rephrase the request or start a fresh session to continue.',
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
  // Consequence, accepted deliberately: a truncation with no partial text stays
  // invisible on live surfaces (unchanged from before #952). Fixing that needs a
  // display-only event channel that renders WITHOUT becoming a terminal message
  // — tracked as a follow-up, not bolted on here.
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
