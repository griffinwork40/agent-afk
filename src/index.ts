/**
 * Agent AFK library entry point.
 * Re-exports agent (core) and telegram modules.
 * @module agent-afk
 */

export {
  AgentSession,
  SubagentManager,
  createCanUseToolHook,
  OpenAICompatibleProvider,
  openaiCompatibleProvider,
  providerForModel,
  resolveProvider,
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
  RenderHints,
  ResponseMetadata,
  SDKStatus,
  SendMessageOptions,
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
} from './agent/index.js';
export type { DiffHunk, DiffLine, DiffPayload } from './utils/diff.js';

export { TelegramBot, SessionManager } from './telegram/index.js';
export type { BotOptions, SessionManagerOptions } from './telegram/index.js';
