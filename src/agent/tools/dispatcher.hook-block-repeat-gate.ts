/**
 * Hook-block repeat gate wired into the pre-dispatch gate chain (#3736).
 *
 * Extracted from `dispatcher.pre-dispatch-gates.ts` to stay under the
 * 350-code-line ceiling. Contains:
 *   - {@link applyHookBlockRepeatGate} — the gate function called in the
 *     `HookBlockedError` catch after the denial breaker runs.
 *   - {@link resetHookBlockRepeatBreaker} — reset on any successful tool call.
 *
 * Both are re-exported from `dispatcher.pre-dispatch-gates.ts` so existing
 * importers are unchanged; import from there, not here.
 *
 * @module agent/tools/dispatcher.hook-block-repeat-gate
 */

import {
  HOOK_BLOCK_REPEAT_THRESHOLD,
  HOOK_BLOCK_REPEAT_FAILURE_CLASS,
  recordHookBlock,
  resetHookBlockRepeat,
  buildHookBlockRepeatMessage,
  buildHookBlockRepeatEscalation,
} from './hook-block-repeat-breaker.js';
import { DENIAL_BREAKER_FAILURE_CLASS, isSubagentContainmentDenial } from './denial-circuit-breaker.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { PreDispatchGateDeps, PreDispatchGateMutableState } from './dispatcher.pre-dispatch-gates.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';

/**
 * Clear the hook-block repeat breaker on any successful tool result (#3736).
 * Called alongside {@link resetDenialBreaker} on every non-error tool result.
 */
export function resetHookBlockRepeatBreaker(state: PreDispatchGateMutableState): void {
  state.hookBlockRepeat = resetHookBlockRepeat();
}

/**
 * Hook-block repeat gate (#3736). Called from the `HookBlockedError` catch
 * AFTER `recordForkReadDenial` so fork-containment denials are still counted
 * by the denial breaker first, and this breaker catches everything else.
 *
 * Counts consecutive `PreToolUse` blocks keyed on `toolName` (the stable,
 * framework-owned gate identity). Resets on any successful tool call.
 *
 * Skips blocks owned by the denial breaker:
 *   (a) `failureClass === 'denial-breaker'` — already upgraded by that breaker.
 *   (b) `isSubagentContainmentDenial(reason)` — containment denial; the
 *       "widen readRoots" remedy of the denial breaker applies, not this one.
 *
 * At threshold:
 *   - **Forked children** (`parentSessionId` set): upgrades result to
 *     `failureClass: 'hook-block-repeat'` — the provider loop surfaces a
 *     loud `error` event identical to the denial-breaker path.
 *   - **Top-level sessions**: appends a one-time escalation message to the
 *     block `content` instructing the agent to stop retrying and report Blocked.
 *
 * The first trip emits a `hook_block_repeat_tripped` session-phase trace event.
 * Skipped on the parallel-gate path (parallelSafe) — caller re-runs sequentially.
 */
export function applyHookBlockRepeatGate(
  call: ToolCall,
  blockResult: ToolResult,
  deps: PreDispatchGateDeps,
  /**
   * The raw hook block reason (err.reason on the sequential path; undefined
   * on the parallel path where blockResult.blockReason carries it instead).
   */
  rawReason?: string,
): ToolResult {
  const reason = rawReason ?? blockResult.blockReason;
  if (blockResult.failureClass === DENIAL_BREAKER_FAILURE_CLASS) return blockResult;
  if (isSubagentContainmentDenial(reason)) return blockResult;

  const { state: next, count } = recordHookBlock(deps.state.hookBlockRepeat, call.name);
  deps.state.hookBlockRepeat = next;

  if (count < HOOK_BLOCK_REPEAT_THRESHOLD) return blockResult;

  if (count === HOOK_BLOCK_REPEAT_THRESHOLD) {
    void emitSessionPhase(deps.traceWriter, {
      phase: 'hook_block_repeat_tripped',
      metadata: {
        tool: call.name,
        count,
        fork: deps.parentSessionId !== undefined,
        ...(deps.subagentId !== undefined ? { subagentId: deps.subagentId } : {}),
      },
    });
  }

  if (deps.parentSessionId !== undefined) {
    return {
      content: buildHookBlockRepeatMessage(call.name, count),
      isError: true,
      failureClass: HOOK_BLOCK_REPEAT_FAILURE_CLASS,
    };
  }

  if (!next.escalated) {
    next.escalated = true;
    const existing = typeof blockResult.content === 'string' ? blockResult.content : '';
    return { ...blockResult, content: existing + buildHookBlockRepeatEscalation(call.name, count) };
  }

  return blockResult;
}
