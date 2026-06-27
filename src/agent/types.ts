/**
 * Type definitions for the Agent SDK wrapper (barrel module).
 *
 * Submodules live under `./types/`. This file re-exports their public surface
 * so downstream callers can keep importing from `../agent/types.js`.
 *
 * @module agent/types
 */

// Re-export SDK types used throughout the harness so callers can import them
// from a single place instead of reaching into the SDK package.
export type {
  AccountInfo,
  AgentInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  OnElicitation,
  PermissionMode,
  SDKControlGetContextUsageResponse,
  SDKStatus,
  SlashCommand,
  ThinkingConfig,
} from './types/sdk-types.js';

export type { ClaudeModel, AgentModelInput } from './types/model-types.js';
export type {
  CanUseTool,
  PermissionBubbler,
  InputStreamRef,
} from './types/permission-types.js';
export type { ToolConfig, AgentConfig, ResumeHistoryTurn } from './types/config-types.js';
export type {
  MessageRole,
  ResponseMetadata,
  Message,
  MessageChunk,
  SendMessageOptions,
  StructuredMessageOptions,
  ToolResultChunk,
  ToolDiffChunk,
} from './types/message-types.js';
export type {
  SessionState,
  SessionIdentity,
  SessionMetadata,
  OutputEvent,
  ProgressEvent,
  SubagentProgressMeta,
  SubagentProgressSink,
  RewindFilesResult,
  IAgentSession,
} from './types/session-types.js';
