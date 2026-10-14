/**
 * Agent SDK wrapper module
 * @module agent
 */

export { AgentSession } from './session.js';
export { query, queryText, queryStructured } from './query.js';
export type { QueryOptions } from './query.js';
export { SubagentManager } from './subagent.js';
export { createCanUseToolHook } from './permissions.js';
export { BudgetExceededError } from '../utils/errors.js';
export { OpenAICompatibleProvider, openaiCompatibleProvider } from './providers/openai-compatible/index.js';
export { providerForModel, resolveProvider } from './providers/index.js';
export type { BundledProviderName } from './providers/index.js';
export type {
  AccountInfo,
  AgentConfig,
  AgentModelInput,
  CanUseTool,
  ClaudeModel,
  IAgentSession,
  McpServerStatus,
  Message,
  MessageChunk,
  MessageRole,
  ModelInfo,
  OutputEvent,
  PermissionBubbler,
  PermissionMode,
  ResponseMetadata,
  SDKStatus,
  SendMessageOptions,
  StructuredMessageOptions,
  SessionIdentity,
  SessionMetadata,
  SessionState,
  SlashCommand,
  ToolConfig,
  ToolDiffChunk,
  ToolResultChunk,
} from './types.js';
export type {
  CanUseToolContext,
  PermissionDecision,
  ToolPermission,
  ToolPermissionMode,
  ToolPermissionRules,
} from './permissions.js';
export type {
  ForkSubagentOptions,
  SubagentHandle,
  SubagentManagerOptions,
  SubagentResult,
  SubagentStatus,
} from './subagent.js';
export type { ModelProvider, ProviderQuery, ProviderEvent, ProviderUserTurn } from './provider.js';
export type { SessionRef } from './session-ref.js';
export type { RenderHints } from './providers/anthropic-direct/types.js';
export { tool } from './tools/custom-tool.js';
export type { CustomToolDef } from './tools/custom-tool.js';
