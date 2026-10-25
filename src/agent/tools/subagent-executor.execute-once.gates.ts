/**
 * Pre-fork gates extracted from `executeOnce` (200-line function ceiling).
 *
 * @module agent/tools/subagent-executor.execute-once.gates
 */

import type { RegisteredAgent } from '../agents/index.js';
import type { ToolResult } from './types.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';

/** Named-agent resolution. A miss fails fast with the available list. */
export function resolveNamedAgent(
  ctx: Pick<SubagentExecutorContext, 'agentRegistry'>,
  agentType: string | undefined,
): { namedAgent: RegisteredAgent | undefined } | { error: ToolResult } {
  if (agentType === undefined) return { namedAgent: undefined };
  const namedAgent = ctx.agentRegistry?.get(agentType);
  if (namedAgent !== undefined) return { namedAgent };
  const available = [...(ctx.agentRegistry?.keys() ?? [])].sort().join(', ');
  return {
    error: {
      content: `Agent type "${agentType}" not found. Available agent types: ${available.length > 0 ? available : '(none)'}`,
      isError: true,
    },
  };
}
