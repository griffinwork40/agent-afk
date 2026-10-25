/**
 * Terminal assistant-message + turn.completed emitter for the openai-compatible
 * turn driver.
 *
 * Extracted from `turn-driver.ts` (350-code-line ceiling) — the `emitTurnTerminal`
 * generator was the single largest self-contained concern that could move without
 * changing the public surface of `turn-driver.ts`.
 *
 * @module agent/providers/openai-compatible/query/turn-driver.emit-terminal
 */

import type { ProviderEvent, ProviderUsage } from '../../../provider.js';
import {
  isTruncationStopReason,
  truncationNotice,
} from '../../shared/truncation.js';
import {
  TOOL_USE_LOOP_CAPPED,
} from '../../shared/tool-loop-cap.js';
import {
  SOFT_DEADLINE_WIND_DOWN,
} from '../../shared/soft-deadline.js';
import { CONTEXT_PRESSURE_WIND_DOWN } from '../../shared/context-pressure.js';
import { finishTurn } from './turn-iteration.js';
import type { TurnDriverContext } from './turn-driver.js';

/**
 * Emit the terminal assistant.message event (with truncation notice appended
 * when the stop reason is a runtime output-token ceiling) followed by
 * `turn.completed`.
 *
 * Extracted from `runTurnInner` to keep it under the 200-line ceiling.
 * All parameters are explicit — no closure over outer locals.
 */
export async function* emitTurnTerminal(
  ctx: TurnDriverContext,
  finalAssistantText: string,
  droppedToolNames: string[],
  accumulatedUsage: ProviderUsage,
  windDownReason: typeof TOOL_USE_LOOP_CAPPED | typeof SOFT_DEADLINE_WIND_DOWN | typeof CONTEXT_PRESSURE_WIND_DOWN | null,
  turnStartTime: number,
): AsyncGenerator<ProviderEvent> {
  // Fix #3963 (fix 4): detect raw tool-call markup leaking into the wind-down
  // final text.  Servers that only parse tool calls when the `tools` array is
  // present return the markup as plain text when wind-down strips tools — so
  // the last round emits something like `<tool_call>{"name":"bash"…}</tool_call>`
  // as the assistant answer.  Flag it as a partial/incomplete answer and
  // replace the text so the parent never treats markup as a real answer.
  if (windDownReason !== null && /^[\s\S]*<tool_call[\s>]/i.test(finalAssistantText)) {
    finalAssistantText = '[Incomplete wind-down: server returned raw tool-call markup instead of a text answer. Partial tool outputs are journaled; resume from saved work.]';
  }

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
