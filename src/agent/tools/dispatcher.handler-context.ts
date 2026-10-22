import type { ToolCall } from '../providers/anthropic-direct/types.js';
import type { ToolHandlerContext } from './types.js';
import type { SessionToolDispatcherOptions } from './dispatcher.js';
import { isYieldableTool } from './user-yield.js';
import { isDetachableTool } from './detach-bash.js';

/**
 * Returns a per-call handler context that augments the base `handlerContext`
 * with the tool-call-specific fields (`toolUseId`, `traceWriter`, and
 * the per-call bash output tail callback when the reporter factory is set).
 */
export function callHandlerContext(
  base: ToolHandlerContext, call: ToolCall, options: Pick<SessionToolDispatcherOptions,
    'bashOutputTailReporter' | 'traceWriter' | 'userAttention' | 'detachRegistry' | 'processJobs'>,
): ToolHandlerContext {
  const tailCallback =
    call.name === 'bash' && options.bashOutputTailReporter !== undefined && call.id
      ? options.bashOutputTailReporter(call.id)
      : undefined;
  return {
    ...base,
    toolUseId: call.id,
    ...(options.traceWriter !== undefined ? { traceWriter: options.traceWriter } : {}),
    ...(tailCallback !== undefined ? { onBashOutputTail: tailCallback } : {}),
    // Yield contract: ONLY opted-in tools may observe the operator's queue,
    // so a non-yieldable tool (bash) can never be told to stop early.
    ...(options.userAttention !== undefined && isYieldableTool(call.name)
      ? { userAttention: options.userAttention }
      : {}),
    // Detach contract (#2542): inject the registry into handler-backed detachable
    // tools (bash) so Ctrl+B can free the model's turn while the underlying
    // operation keeps running. `compose` is detachable but bypasses this path —
    // it receives detachRegistry via coreExecDeps() → executeCompose() instead.
    ...(options.detachRegistry !== undefined && isDetachableTool(call.name)
      ? { detachRegistry: options.detachRegistry }
      : {}),
    ...(options.processJobs !== undefined && call.name === 'bash' ? { processJobs: options.processJobs } : {}),
  };
}
