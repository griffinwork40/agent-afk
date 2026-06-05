/**
 * Permission-related types shared across agent modules.
 * @module agent/types/permission-types
 */

import type { CanUseTool } from './sdk-types.js';

export type { CanUseTool };

/**
 * Wraps a canUseTool callback so a parent session can share its permission
 * handler with spawned subagents (permission bubbling).
 */
export interface PermissionBubbler {
  canUseTool: CanUseTool;
}

/**
 * Narrow reference to a session's input stream for pushing user messages.
 * Used by SubagentStop handlers to inject context into parent sessions.
 */
export interface InputStreamRef {
  pushUserMessage(content: string): void;
}
