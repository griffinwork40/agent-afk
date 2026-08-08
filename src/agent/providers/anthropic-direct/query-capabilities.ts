/**
 * Read-only capability and introspection helpers for
 * {@link AnthropicDirectQuery}.
 *
 * Extracted verbatim from `query-runtime.ts` (#824 split). These are pure
 * reads over session state — no mutation, no SDK calls — so they take their
 * inputs directly rather than a context object.
 *
 * @module agent/providers/anthropic-direct/query-capabilities
 */

import type {
  ProviderAccountInfo,
  ProviderContextUsage,
  ProviderMcpServerStatus,
} from '../../provider.js';
import { contextLimitFor } from '../../model-limits.js';
import type { SessionState } from './query/session-state.js';
import { contextWindowTokensUsed, buildContextUsageFields } from './query/auto-compact.js';
import type { AuthMode } from './types.js';

/**
 * Point-in-time context-footprint report for the REPL's ContextSampler
 * (src/cli/context-sampler.ts). Without this the sampler's `cachedRatio` stays
 * undefined and the status line falls through to a local-stats approximation
 * that historically over-counted cache_read.
 */
export function computeContextUsage(state: SessionState): ProviderContextUsage {
  // `state.lastUsage` is `accumulatedUsage` from the last completed turn
  // (loop.ts). Use the context-window footprint it carries
  // (`contextWindowTokens` = last round's input + cache_read + cache_creation
  // + output), NOT input+output alone: Anthropic's input_tokens excludes the
  // cached conversation prefix, which is usually the bulk of the window.
  const last = state.lastUsage;
  // requestedModel (not the wire currentModel): 1M aliases (opus_1m) resolve
  // to the same wire id as their base but report a 1M window. Looking up the
  // wire id would yield the 200k fallback and mis-state both the % and the
  // `maxTokens` the REPL `/tokens` view displays.
  const contextLimit = contextLimitFor(state.requestedModel);
  let percentage: number | undefined;
  if (last && contextLimit > 0) {
    const used = contextWindowTokensUsed(last);
    percentage = Math.min(100, Math.max(0, (used / contextLimit) * 100));
  }
  // Translate the camelCase ProviderUsage into the snake_case apiUsage +
  // top-level totalTokens the REPL consumers read. See buildContextUsageFields.
  const { totalTokens, apiUsage } = buildContextUsageFields(last);
  return {
    // Context-window usage shape: tools/agents are per-entry token stats AFK does not populate (NOT AgentConfig.agents).
    tools: [],
    agents: [],
    isAutoCompactEnabled: state.autoCompactThreshold !== undefined,
    apiUsage,
    totalTokens,
    ...(percentage !== undefined ? { percentage } : {}),
    maxTokens: contextLimit,
  };
}

/** Live MCP server connection summary; empty when no manager is wired. */
export function mcpServerStatusList(
  mcpManager: import('../../mcp/index.js').McpManager | undefined,
): ProviderMcpServerStatus[] {
  if (!mcpManager) return [];
  return mcpManager.getServerStates().map((s) => ({
    name: s.serverName,
    status: s.status,
  }));
}

/** Subscription vs. API-key billing posture, derived from the auth mode. */
export function accountInfoFor(authMode: AuthMode): ProviderAccountInfo {
  return {
    subscriptionType: authMode === 'oauth' ? 'claude-subscription' : 'api-key',
  };
}
