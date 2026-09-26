/**
 * Type-safe mappers from provider-side shapes to session-side types.
 *
 * `ProviderQuery` methods return loose structural types (`ProviderModelInfo`,
 * `ProviderAgentInfo`, etc.) whose optional fields are a subset of the
 * stricter session-side types (`ModelInfo`, `AgentInfo`, etc.). These
 * helpers fill in the required defaults so the delegations in
 * `AgentSession` can drop the unsafe `as` casts.
 *
 * @module agent/session/provider-type-mappers
 */

import type {
  AgentInfo,
  McpServerStatus,
  ModelInfo,
  SDKControlGetContextUsageResponse,
} from '../types.js';
import type {
  ProviderAgentInfo,
  ProviderContextUsage,
  ProviderModelInfo,
  ProviderMcpServerStatus,
} from '../provider.js';

/** Map a provider model entry to the session-side `ModelInfo`. */
export function toModelInfo(p: ProviderModelInfo): ModelInfo {
  return {
    value: p.value,
    displayName: p.displayName ?? '',
    description: p.description ?? '',
  };
}

/** Map a provider agent entry to the session-side `AgentInfo`. */
export function toAgentInfo(p: ProviderAgentInfo): AgentInfo {
  return {
    name: p.name,
    description: p.description ?? '',
  };
}

/**
 * Cast a provider context-usage payload to `SDKControlGetContextUsageResponse`.
 *
 * The actual runtime value supplied by every provider already satisfies the
 * full `SDKControlGetContextUsageResponse` shape (providers populate all
 * required fields). `ProviderContextUsage` is deliberately loose (index
 * signature) to avoid coupling the provider interface to the SDK type, but
 * that means TypeScript can't verify structural compatibility at the
 * provider boundary. We isolate the cast here, behind a named function,
 * so it appears exactly once and is easy to audit.
 */
export function toContextUsageResponse(
  p: ProviderContextUsage,
): SDKControlGetContextUsageResponse {
  return p as unknown as SDKControlGetContextUsageResponse;
}

/**
 * Narrow a provider MCP-status row to the session-side `McpServerStatus`.
 *
 * `ProviderMcpServerStatus.status` is typed as `string` (provider boundary
 * is deliberately loose), but every live provider only ever populates values
 * from the session-side union. We assert the narrowing here rather than
 * scattering it across call sites.
 */
export function toMcpServerStatus(p: ProviderMcpServerStatus): McpServerStatus {
  return p as unknown as McpServerStatus;
}
