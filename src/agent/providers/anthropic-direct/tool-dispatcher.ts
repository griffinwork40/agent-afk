/**
 * Pluggable tool dispatcher for the `anthropic-direct` provider.
 *
 * Defines the contract that `loop.ts` calls when the model emits `tool_use`
 * blocks, plus a default `RejectAllToolDispatcher` that returns an
 * `isError: true` result for every call. The default dispatcher is what
 * makes v1 ship safely without real tool implementations — the model sees
 * an honest error and can recover or end-turn.
 *
 * @module agent/providers/anthropic-direct/tool-dispatcher
 */

import type { ToolCall, ToolResult, ToolDispatcherLike } from './types.js';

/**
 * Pluggable tool dispatcher contract. Implementations execute tool calls
 * issued by the model and return the result that becomes the body of the
 * outbound `tool_result` content block.
 *
 * Aliases the structural `ToolDispatcherLike` from `types.ts` so the public
 * name lives in this module while the structural alias used by `loop.ts`
 * stays in `types.ts` — avoids a layering cycle if a future dispatcher
 * implementation wants to import from the loop.
 */
export interface ToolDispatcher extends ToolDispatcherLike {}

/**
 * Default dispatcher used when no real tool implementations are wired in.
 * Returns `{ isError: true, content: <message> }` for every call so the
 * model can either recover gracefully or end the turn — preferable to a
 * silent failure or a thrown error that aborts the whole session.
 *
 * Implemented as a real class (not a const) so consumers can
 * `extends RejectAllToolDispatcher` and override only specific tools.
 */
export class RejectAllToolDispatcher implements ToolDispatcher {
  async execute(call: ToolCall): Promise<ToolResult> {
    return {
      isError: true,
      content: `Tool "${call.name}" is not implemented in the anthropic-direct provider (v1). Wire a real ToolDispatcher to enable tool execution.`,
    };
  }
}

export type { ToolCall, ToolResult } from './types.js';
