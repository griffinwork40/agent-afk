/**
 * Tool-result surfacing and history commit for one round.
 *
 * Emits `tool.output` (and the sidecar `tool.diff`) per call, assembles the
 * model-facing `tool_result` blocks in original order, and commits them to
 * history as the follow-up user turn.
 *
 * Invariant: `ToolResult.render` is NEVER model-facing. The block assembly
 * below destructures only `content`, `isError`, and `image`, so `render` is
 * structurally out of scope at the push site rather than merely excluded by
 * convention. Keep it that way — this is the correctness boundary for the diff
 * render channel.
 *
 * @module agent/providers/anthropic-direct/loop/tool-results
 */

import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput, ToolCall, ToolResult } from '../types.js';
import { emitToolCall } from '../../../trace/emit.js';
import { buildToolCallCompletedPayload } from '../../shared/tool-call-trace.js';
import { DENIAL_BREAKER_FAILURE_CLASS } from '../../../tools/denial-circuit-breaker.js';
import { DenialCircuitBreakerError } from '../../../../utils/errors.js';

/**
 * Commit outcome.
 *
 * `denial-tripped` means the denial circuit breaker fired and a terminal
 * `error` event has already been yielded; history is consistent and the caller
 * should return.
 */
export type ToolResultsOutcome = 'committed' | 'denial-tripped';

/**
 * Surface every tool result, then push the assembled `tool_result` user turn.
 */
export async function* emitAndCommitToolResults(
  calls: ToolCall[],
  results: ToolResult[],
  startTimes: Map<string, number>,
  input: RunTurnInput,
): AsyncGenerator<ProviderEvent, ToolResultsOutcome, void> {
  // Yield results and build tool_result blocks in original order.
  const toolResultBlocks: ToolResultBlockParam[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const result = results[i]!;

    // Witness layer: tool_call.completed pairs with the .started event emitted
    // at dispatch. `truncated` is sourced from the handler's structured
    // `ToolResult.truncated` flag — set by `handlers/bash.ts` and
    // `handlers/grep.ts` whenever their byte cap is hit. The sentinel-substring
    // fallback survives for third-party tool handlers that emit the
    // `[output truncated …]` sentinel without setting the structured flag
    // (back-compat). Fire-and-forget to keep the loop iteration cheap.
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
      ...(result.capturePath !== undefined ? { capturePath: result.capturePath } : {}),
      ...(result.incomplete === true ? { incomplete: true } : {}),
      ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
      ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
        ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
        : {}),
      // Carry WHY the call failed to the render-facing event, not just the
      // trace event above. Without this the tool-lane cannot tell a permission
      // gate saying no from a tool that broke, and renders both as a red ✗.
      // Parity with dispatch-append.ts's tool.output yield.
      ...(result.failureClass ? { failureClass: result.failureClass } : {}),
      // Plumb tool-measured duration so the TUI outcome row can show `· Xs`.
      // The provider-side durationMs above measures round-trip including
      // provider overhead; result.durationMs is the handler's own stopwatch.
      // Prefer the handler value when available (bash always sets it), fall
      // back to the provider measurement for non-bash tools that don't.
      durationMs: result.durationMs !== undefined ? result.durationMs : durationMs,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      sessionId: input.ctx.sessionId,
    };

    // Sidecar render-only event for file-mutation tools. Travels on a separate
    // event variant — the `toolResultBlocks.push()` call below cannot reference
    // `result.render` (it is not in scope there), so a future refactor cannot
    // accidentally leak diff payloads into the model's `tool_result` content.
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
    // model-facing: when set it becomes an `image` content block alongside the
    // text. `render` remains excluded.
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
            ...(resultContent.length > 0 ? [{ type: 'text' as const, text: resultContent }] : []),
          ]
        : resultContent;
    toolResultBlocks.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: toolResultContent,
      ...(resultIsError === true ? { is_error: true } : {}),
    });
  }

  // Harness notes are appended as genuine user text blocks, structurally outside
  // tool_result content. Child output cannot forge this path by printing JSON.
  const harnessNotes = results.flatMap((result) =>
    result.harnessUserMessage?.kind === 'queued_user_message'
      ? [{ type: 'text' as const, text: result.harnessUserMessage.text }]
      : [],
  );
  const toolResultTurn: MessageParam = {
    role: 'user',
    content: [...toolResultBlocks, ...harnessNotes] as ContentBlockParam[],
  };
  input.messages.push(toolResultTurn);

  // Denial circuit breaker (#546): the dispatcher tagged a result
  // `denial-breaker` after a forked child hit N consecutive path-approval read
  // denials with no progress. Surface it as a LOUD `error` event — never a
  // silent partial — so the shared subagent handle rethrows it into a
  // structured `buildResultFromError` failure the parent can act on (mirrors
  // the TimeoutError teardown). History is already consistent here (assistant
  // `tool_use` + matching `tool_result` blocks both pushed), so returning is
  // safe; the fork is done. A dispatcher throw would instead be swallowed by
  // the executeBatch/execute catch at dispatch and the loop would keep spinning
  // — which is the exact failure this breaker exists to prevent.
  const denialTrip = results.find((r) => r.failureClass === DENIAL_BREAKER_FAILURE_CLASS);
  if (denialTrip) {
    yield { type: 'error', error: new DenialCircuitBreakerError(denialTrip.content) };
    return 'denial-tripped';
  }

  return 'committed';
}
