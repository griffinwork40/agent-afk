import { emitToolCall } from '../../../trace/emit.js';
import type { TraceSink } from '../../../trace/index.js';
import type { ProviderEvent } from '../../../provider.js';
import type { ToolCall, ToolResult } from '../../anthropic-direct/types.js';
import { buildToolCallCompletedPayload } from '../../shared/tool-call-trace.js';

/**
 * Emit `tool.output` (and `tool.diff`) provider events for every dispatched
 * tool call result, record the `tool_call.completed` witness trace event, and
 * push the merged `{ call, result }` pair into `results`.
 *
 * Extracted from `dispatchAndAppendToolCalls` to keep that function at or
 * below its baselined line count. Parameters mirror the locals the loop
 * consumed from the enclosing scope — no closure over shared state.
 */
export async function* emitDispatchedToolOutputs({
  calls,
  dispatcherResults,
  parseErrors,
  startTimes,
  traceWriter,
  subagentId,
  sessionId,
  results,
}: {
  calls: readonly ToolCall[];
  dispatcherResults: ToolResult[];
  parseErrors: Map<string, string>;
  startTimes: Map<string, number>;
  traceWriter: TraceSink | undefined;
  subagentId: string | undefined;
  sessionId: string;
  results: { call: ToolCall; result: ToolResult }[];
}): AsyncGenerator<ProviderEvent, void> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    let result = dispatcherResults[i]!;
    // Layer parse-error diagnostics in front of the dispatcher result —
    // the model needs to know its arguments were malformed.
    const parseErr = parseErrors.get(call.id);
    if (parseErr !== undefined) {
      result = {
        content: `${parseErr}\n--\n${result.content}`,
        isError: true,
        ...(result.truncated === true ? { truncated: true } : {}),
      };
    }
    results.push({ call, result });

    // Witness layer: tool_call.completed pairs with the .started event
    // emitted above. Payload built by the shared
    // `buildToolCallCompletedPayload` (providers/shared/tool-call-trace.ts)
    // so both providers construct this event identically. Fire-and-forget
    // to keep the loop iteration cheap.
    const startedAt = startTimes.get(call.id);
    // Use the per-call completedAt stamped by the dispatcher when the call's
    // own promise settled (not the batch's end time). Falls back to Date.now()
    // for calls that bypassed the dispatcher (aborted, hook-blocked, etc.).
    // See issue #2249.
    const completedAt = result.completedAt ?? Date.now();
    const durationMs = typeof startedAt === 'number' ? completedAt - startedAt : 0;
    const truncated = result.truncated === true || result.content.includes('[output truncated');
    void emitToolCall(
      traceWriter,
      buildToolCallCompletedPayload({
        toolUseId: call.id,
        name: call.name,
        result,
        truncated,
        durationMs,
        subagentId,
      }),
    );

    yield {
      type: 'tool.output',
      toolUseId: call.id,
      toolName: call.name,
      content: result.content,
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(result.capturePath !== undefined ? { capturePath: result.capturePath } : {}),
      ...(result.incomplete === true ? { incomplete: true } : {}),
      ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
      // Plumb concurrency-batch membership onto the render-facing event, not
      // just the trace event above, so the TUI `∥i/N` badge works here too.
      // Parity with anthropic-direct/loop.ts's tool.output yield — omitting it
      // silently drops the badge for every openai-compatible session.
      ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
        ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
        : {}),
      // Carry WHY the call failed so the tool-lane can render a deliberate
      // refusal neutrally instead of as a red ✗. Parity with
      // anthropic-direct/loop/tool-results.ts — omitting it silently drops
      // the benign-rejection glyph for every openai-compatible session.
      ...(result.failureClass ? { failureClass: result.failureClass } : {}),
      // Plumb tool-measured duration so the TUI outcome row can show `· Xs`.
      // Prefer handler value (bash always sets result.durationMs), fall back
      // to provider-side measurement for non-bash tools.
      durationMs: result.durationMs !== undefined ? result.durationMs : durationMs,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      sessionId,
    };
    if (result.render?.diff) {
      yield {
        type: 'tool.diff',
        toolUseId: call.id,
        diff: result.render.diff,
        sessionId,
      };
    }
  }
}
