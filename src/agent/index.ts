/**
 * Agent SDK wrapper module
 * @module agent
 */

export { AgentSession } from './session.js';
export { query, queryText, queryStructured } from './query.js';
export type { QueryOptions } from './query.js';
export { SubagentManager } from './subagent.js';
export { createCanUseToolHook } from './permissions.js';
export { AbortGraph } from './abort-graph.js';
export { DEFAULT_SESSION_TIMEOUT_MS, RESET_DRAIN_TIMEOUT_MS, withTimeout } from './timeout.js';
export { extractStructuredOutput } from './output-extractor.js';
export { createHookRegistry } from './hooks.js';
export { HookBlockedError, BudgetExceededError } from '../utils/errors.js';
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
export type { ChildAbortedEvent, ChildAbortedListener } from './abort-graph.js';
export type { WithTimeoutOptions } from './timeout.js';
export { runDAG, validateDAG } from './dag.js';
export { runSubagentDAG } from './dag-subagent.js';
export type { DAGEdge, DAGGraph, DAGNode, DAGRunOptions, DAGRunResult } from './dag.js';
export type { SubagentDAGNode, SubagentDAGOptions } from './dag-subagent.js';
export type {
  HarnessHookEvent,
  HookContext,
  HookDecision,
  HookHandler,
  HookRegistry,
  PostToolUseContext,
  PreCompactContext,
  PreToolUseContext,
  SessionEndContext,
  SessionStartContext,
  StopContext,
  SubagentHookStatus,
  SubagentStartContext,
  SubagentStopContext,
} from './hooks.js';
export type {
  ModelProvider,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderEvent,
  ProviderUserTurn,
  ProviderUsage,
  ProviderSessionInfo,
  ProviderProgress,
  ProviderCommandInfo,
  ProviderModelInfo,
  ProviderAgentInfo,
  ProviderContextUsage,
  ProviderMcpServerStatus,
  ProviderAccountInfo,
  ProviderRewindResult,
} from './provider.js';
export type { DaemonHandle, DaemonOptions } from './daemon.js';
export type { SessionRef } from './session-ref.js';
export { SessionToolDispatcher, createBuiltinHandlers, builtinToolSchemas, checkToolPermission } from './tools/index.js';
export type { ToolHandler, ToolPermissionConfig, SessionToolDispatcherOptions } from './tools/index.js';
export type { RenderHints } from './providers/anthropic-direct/types.js';
export { tool } from './tools/custom-tool.js';
export type { CustomToolDef } from './tools/custom-tool.js';
