/**
 * Coordinator for a `stop_reason: 'tool_use'` round.
 *
 * Owns the history mutation contract end to end: push the assistant turn,
 * delegate dispatch and result-commit, and roll the push back if anything
 * between them throws. Then runs the round epilogue — progress event, tool-use
 * cap check, wind-down arming.
 *
 * Invariant: the rollback `try`/`catch` lives HERE and nowhere else. It must
 * span the assistant push through the `tool_result` commit as a single unit,
 * because a throw anywhere in between leaves history terminating in an
 * unmatched `tool_use` — which 400s every subsequent API call. Splitting the
 * push from its rollback across modules would silently break that.
 *
 * Invariant: `iterations += 1` sits OUTSIDE the try, exactly as it did
 * pre-split. A round that threw and rolled back did not happen.
 *
 * @module agent/providers/anthropic-direct/loop/tool-round
 */

import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput, TurnResult } from '../types.js';
import { summarizeToolInput } from '../../shared/tool-input-summary.js';
import {
  TOOL_USE_LOOP_CAPPED,
  WIND_DOWN_NOTE,
  shouldWindDown,
} from '../../shared/tool-loop-cap.js';
import { dispatchToolCalls } from './tool-dispatch.js';
import { emitAndCommitToolResults } from './tool-results.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/**
 * What the orchestrator should do after a tool round.
 *
 * `terminated` means a terminal event was already yielded (abort, denial
 * breaker, or the tool-use cap hard stop).
 */
export type ToolRoundOutcome = 'continue' | 'terminated';

/**
 * Run one full tool-use round: dispatch, surface results, commit history, then
 * decide whether the turn continues.
 */
export async function* runToolRound(
  turnResult: TurnResult,
  input: RunTurnInput,
  turn: TurnAccumulator,
  maxIterations: number,
): AsyncGenerator<ProviderEvent, ToolRoundOutcome, void> {
  // Rollback contract: capture the pre-push length so any throw between here
  // and the `tool_result` commit can splice the orphaned assistant message back
  // out. Without this, an unexpected throw inside `executeBatch` / `execute`
  // (one not absorbed into an `is_error: true` ToolResult) would leave history
  // terminating in an unmatched `tool_use` — every subsequent API call 400s.
  const messagesRollbackIdx = input.messages.length;
  input.messages.push({ role: 'assistant', content: turnResult.assistantBlocks });

  try {
    // Accumulate the cumulative tool-call tally BEFORE dispatch so the progress
    // emit below reports calls-so-far including this round's batch. One round
    // can carry N parallel tool_use blocks, so this advances by the block
    // count, not by 1.
    turn.toolCallCount += turnResult.toolUseBlocks.length;

    const dispatched = yield* dispatchToolCalls(turnResult, input, turn);
    if (dispatched.kind === 'aborted') return 'terminated';

    const committed = yield* emitAndCommitToolResults(
      dispatched.calls,
      dispatched.results,
      dispatched.startTimes,
      input,
    );
    if (committed === 'denial-tripped') return 'terminated';
  } catch (err) {
    // Rollback the orphaned assistant `tool_use` push above so the next turn's
    // API call does not 400 with "tool_use ids were found without tool_result
    // blocks immediately after". Any path that reached the `tool_result` commit
    // (or the earlier aborted-results push at the signal-aborted gate) returned
    // from inside the try with history already consistent, so they do not enter
    // this catch. Re-throw so the outer query-level handler still surfaces the
    // error.
    input.messages.splice(messagesRollbackIdx);
    throw err;
  }

  turn.iterations += 1;

  const lastTool = turnResult.toolUseBlocks[turnResult.toolUseBlocks.length - 1];
  // Semantic summary: name the tool AND its most informative argument (path /
  // command / query via summarizeToolInput) so the progress banner carries real
  // signal — `bash git show f7f0a37…` instead of the old `Iteration 11: used
  // bash`, which conveyed nothing after round 2. `description` stays STABLE
  // across ticks for this task id (the banner dedupes line 0 on commit); the
  // per-tick signal lives in `summary`.
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
    // The wind-down round (tools stripped) still came back as `tool_use` — only
    // reachable if the model emits a tool call against an empty toolset. Honor
    // the cap with a hard stop rather than looping unbounded.
    yield {
      type: 'turn.completed',
      usage: turn.withDuration({ ...turn.usage, stopReason: TOOL_USE_LOOP_CAPPED }),
      sessionId: input.ctx.sessionId,
    };
    return 'terminated';
  }

  if (shouldWindDown(turn.iterations, maxIterations)) {
    // Cap reached. Instead of cutting the turn off HERE — which ends it with no
    // final assistant message and reads as a silent hang — run ONE more round
    // with tools stripped (see the params build in round-request.ts) so the
    // model can synthesize a final answer from what it gathered. Append a brief
    // note to the tool_result turn just pushed so the model knows why its tools
    // are gone. `capReached` guarantees this fires at most once; the guard above
    // hard-stops if the wind-down round pathologically emits another tool_use.
    const lastMsg = input.messages[input.messages.length - 1];
    if (lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: 'text', text: WIND_DOWN_NOTE });
    }
    turn.capReached = true;
  }

  return 'continue';
}
