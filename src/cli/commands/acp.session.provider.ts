import { parseProvider } from '../provider-parser.js';
import type { ParseProviderOptions } from '../provider-parser.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { topLevelSurfaceAllowedTools } from '../../agent/tools/top-level-allowlist.js';

/** Same model routing + Anthropic fallback as the terminal bootstrap. */
export function createAcpProvider(opts: ParseProviderOptions) {
  return parseProvider(undefined, opts) ?? new AnthropicDirectProvider({
    ...(opts.subagentExecutor !== undefined ? { subagentExecutor: opts.subagentExecutor } : {}),
    ...(opts.skillExecutor !== undefined ? { skillExecutor: opts.skillExecutor } : {}),
    ...(opts.composeExecutor !== undefined ? { composeExecutor: opts.composeExecutor } : {}),
    ...(opts.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
    ...(opts.stateStore !== undefined ? { stateStore: opts.stateStore } : {}),
    ...(opts.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
    ...(opts.canUseTool !== undefined ? { canUseTool: opts.canUseTool } : {}),
    permissions: { allowedTools: topLevelSurfaceAllowedTools(opts.mcpManager?.getMcpToolWireNames() ?? []) },
    surface: 'cli',
  });
}
