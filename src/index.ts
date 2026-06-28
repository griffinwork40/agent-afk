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

// Framework SDK surface for out-of-tree skill plugins.
// These re-exports expose the core symbols an external skill plugin installed
// under ~/.afk/plugins/ needs to register skills and read session facets at
// boot, so a plugin can depend on the published `agent-afk` package instead of
// reaching into the source tree. Purely additive — no behavior change.
export {
  registerSkill,
  listSkills,
  getSkill,
} from './skills/index.js';
export type { SkillExecutionContext, SkillMetadata } from './skills/index.js';
export { loadSkillPrompts } from './skills/_lib/prompt-loader.js';
// PluginApi: the host runtime API injected into a code-backed plugin's
// default-export entrypoint. A plugin types its entrypoint as
// `export default (api: PluginApi) => { … }` and registers through `api` so its
// skills land in the host's singleton registry regardless of install layout.
export type { PluginApi } from './agent/plugins/load-entrypoints.js';

export {
  deriveSessionFacet,
  getOrDeriveFacet,
  listSessionIds,
  loadStoredSession,
} from './agent/facets/index.js';
export type {
  SessionFacet,
  StoredSessionInput,
  ToolEventInput,
} from './agent/facets/index.js';

export { describeFailure } from './agent/subagent/result.js';
export { discoverPluginSkillBodies } from './agent/tools/skill-bridge.js';

export { env } from './config/env.js';
export { getSessionsDir, getSkillsDir, getAgentFrameworkDir } from './paths.js';

export { TelegramBot, SessionManager } from './telegram/index.js';
export type { BotOptions, SessionManagerOptions } from './telegram/index.js';
