/**
 * Provider-query passthrough methods, extracted from {@link AgentSession}.
 *
 * These thin delegations forward method calls from the public
 * {@link IAgentSession} surface to the underlying {@link ProviderQuery}.
 * They carry no logic beyond state guards and optional-method fallbacks.
 *
 * Extracted as a separate file solely to keep agent-session.ts within the
 * 350-code-line ceiling. All functions here accept a `PassthroughDeps`
 * context bag rather than a back-reference to `AgentSession`.
 *
 * @module agent/session/provider-passthrough
 */

import type {
  AccountInfo,
  AgentInfo,
  McpServerStatus,
  ModelInfo,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SessionState,
} from '../types.js';
import type {
  ProviderCommandInfo,
  ProviderCompactResult,
  ProviderQuery,
  ProviderRewindConversationResult,
  RewindTarget,
} from '../provider.js';

/** Context bag threaded into the passthrough functions. */
export interface PassthroughDeps {
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getProviderQuery: () => ProviderQuery;
}

/** Forward to `ProviderQuery.supportedCommands()`. */
export function supportedCommands(deps: PassthroughDeps): Promise<ProviderCommandInfo[]> {
  return deps.getProviderQuery().supportedCommands();
}

/** Forward to `ProviderQuery.supportedModels()`. */
export function supportedModels(deps: PassthroughDeps): Promise<ModelInfo[]> {
  return deps.getProviderQuery().supportedModels() as Promise<ModelInfo[]>;
}

/** Forward to `ProviderQuery.supportedAgents()`. */
export function supportedAgents(deps: PassthroughDeps): Promise<AgentInfo[]> {
  return deps.getProviderQuery().supportedAgents() as Promise<AgentInfo[]>;
}

/** Forward to `ProviderQuery.getContextUsage()`. */
export function getContextUsage(
  deps: PassthroughDeps,
): Promise<SDKControlGetContextUsageResponse> {
  return deps.getProviderQuery().getContextUsage() as Promise<SDKControlGetContextUsageResponse>;
}

/** Forward to `ProviderQuery.mcpServerStatus()`. */
export function mcpServerStatus(deps: PassthroughDeps): Promise<McpServerStatus[]> {
  return deps.getProviderQuery().mcpServerStatus() as Promise<McpServerStatus[]>;
}

/** Forward to `ProviderQuery.accountInfo()`. */
export function accountInfo(deps: PassthroughDeps): Promise<AccountInfo> {
  return deps.getProviderQuery().accountInfo();
}

/** Forward to `ProviderQuery.rewindFiles()`. */
export function rewindFiles(
  userMessageId: string,
  options: { dryRun?: boolean } | undefined,
  deps: PassthroughDeps,
): Promise<RewindFilesResult> {
  return deps.getProviderQuery().rewindFiles(userMessageId, options);
}

/**
 * Compact the session's conversation history via the provider.
 * Guards against compacting when closed or busy.
 */
export async function compact(deps: PassthroughDeps): Promise<ProviderCompactResult> {
  if (deps.getState() === 'closed') {
    throw new Error('Cannot compact: session is closed');
  }
  if (deps.getState() !== 'idle') {
    return { compacted: false, reason: 'session-busy', messagesBefore: 0, messagesAfter: 0 };
  }
  const fn = deps.getProviderQuery().compact?.bind(deps.getProviderQuery());
  if (!fn) {
    return { compacted: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 };
  }
  // NOTE: 'compacting' state is set here for AgentSession.compact() only.
  // Auto-compact inside sendMessageStreamInternal does NOT go through this
  // method and therefore does NOT set 'compacting'. This is intentional.
  deps.setState('compacting');
  try {
    return await fn();
  } finally {
    deps.setState('idle');
  }
}

/** List rewind targets from the provider. Returns empty array when closed. */
export function listRewindTargets(deps: PassthroughDeps): RewindTarget[] {
  if (deps.getState() === 'closed') return [];
  return deps.getProviderQuery().listRewindTargets?.() ?? [];
}

/**
 * Rewind the conversation to a prior turn index via the provider.
 * Guards against rewinding when closed or busy.
 */
export async function rewindConversation(
  turnIndex: number,
  deps: PassthroughDeps,
): Promise<ProviderRewindConversationResult> {
  if (deps.getState() === 'closed') {
    throw new Error('Cannot rewind: session is closed');
  }
  if (deps.getState() !== 'idle') {
    return { rewound: false, reason: 'session-busy', messagesBefore: 0, messagesAfter: 0 };
  }
  const fn = deps.getProviderQuery().rewindConversation?.bind(deps.getProviderQuery());
  if (!fn) {
    return { rewound: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 };
  }
  return fn(turnIndex);
}
