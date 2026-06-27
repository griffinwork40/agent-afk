/**
 * Agent AFK library entry point.
 * Re-exports agent (core) and telegram modules.
 * @module agent-afk
 */

export {
  AgentSession,
  query,
  queryText,
  queryStructured,
  SubagentManager,
  createCanUseToolHook,
  OpenAICompatibleProvider,
  openaiCompatibleProvider,
  providerForModel,
  resolveProvider,
  tool,
} from './agent/index.js';
export type {
  AccountInfo,
  AgentConfig,
  AgentModelInput,
  BundledProviderName,
  CanUseTool,
  CanUseToolContext,
  ClaudeModel,
  ForkSubagentOptions,
  IAgentSession,
  McpServerStatus,
  Message,
  MessageChunk,
  MessageRole,
  ModelInfo,
  ModelProvider,
  OutputEvent,
  PermissionBubbler,
  PermissionDecision,
  PermissionMode,
  ProviderEvent,
  ProviderQuery,
  ProviderUserTurn,
  QueryOptions,
  RenderHints,
  ResponseMetadata,
  SDKStatus,
  SendMessageOptions,
  StructuredMessageOptions,
  SessionIdentity,
  SessionMetadata,
  SessionState,
  SessionRef,
  SlashCommand,
  SubagentHandle,
  SubagentManagerOptions,
  SubagentResult,
  SubagentStatus,
  ToolConfig,
  ToolDiffChunk,
  ToolPermission,
  ToolPermissionMode,
  ToolPermissionRules,
  ToolResultChunk,
  CustomToolDef,
} from './agent/index.js';
export type { DiffHunk, DiffLine, DiffPayload } from './utils/diff.js';

export { TelegramBot, SessionManager } from './telegram/index.js';
export type { BotOptions, SessionManagerOptions } from './telegram/index.js';
