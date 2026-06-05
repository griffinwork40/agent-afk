/**
 * Session-level tool system.
 *
 * Provides tool definitions, handlers, and the `SessionToolDispatcher` that
 * integrates with the harness hook system and permission layer.
 *
 * @module agent/tools
 */

export {
  builtinToolSchemas,
  BUILTIN_TOOL_NAMES,
  ALL_TOOL_SCHEMAS,
  agentTool,
  skillTool,
  composeTool,
} from './schemas.js';
export type { ToolHandler, ToolCall, ToolResult, AnthropicToolDef, ToolDispatcher, ConcurrencyClassifier } from './types.js';
export { SessionToolDispatcher, defaultConcurrencyClassifier } from './dispatcher.js';
export type { SessionToolDispatcherOptions } from './dispatcher.js';
export { checkToolPermission } from './permissions.js';
export type { ToolPermissionConfig, PermissionCheckResult } from './permissions.js';
export { createBuiltinHandlers } from './handlers/index.js';
