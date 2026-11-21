/** In-process permission gate extracted to keep the pre-dispatch chain below its size ceiling. */
import { errorMessage } from '../../utils/errors.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { PermissionResult } from '../types/sdk-types.js';
import { emitPreToolUseBlock, type PreDispatchGateDeps } from './dispatcher.pre-dispatch-gates.js';

/**
 * Consult the optional policy after the static allowlist and before bash gates.
 * Only an explicit allow can proceed; its optional input rewrite must be an object.
 * Both sequential execution and safe-classified batches share this gate.
 */
export async function runCanUseTool(
  call: ToolCall,
  deps: PreDispatchGateDeps,
): Promise<ToolResult | null> {
  if (!deps.canUseTool) return null;
  let result: PermissionResult;
  try {
    result = await deps.canUseTool(call.name, (call.input ?? {}) as Record<string, unknown>, {
      signal: call.signal,
      toolUseID: call.id,
    });
  } catch (err) {
    // Fail closed: a throwing policy denies the call rather than crashing the turn.
    const reason = `Tool "${call.name}" denied by canUseTool (threw): ${
      errorMessage(err)
    }`;
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }
  // Runtime callbacks (including plugins) can violate the TypeScript contract.
  const isObject = typeof result === 'object' && result !== null && !Array.isArray(result);
  const isAllow = isObject && result.behavior === 'allow' &&
    (result.updatedInput === undefined || (typeof result.updatedInput === 'object' &&
      result.updatedInput !== null && !Array.isArray(result.updatedInput)));
  if (!isAllow) {
    const reason = isObject && result.behavior === 'deny'
      ? result.message || `Tool "${call.name}" denied by permission policy`
      : `Tool "${call.name}" denied by canUseTool: permission result was malformed`;
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }
  // allow — apply an optional input rewrite in place.
  if (result.behavior === 'allow' && result.updatedInput !== undefined) {
    call.input = result.updatedInput;
  }
  return null;
}
