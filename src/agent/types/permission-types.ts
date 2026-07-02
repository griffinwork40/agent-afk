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
 * Narrow reference to a session's input channels.
 *
 * `pushUserMessage` enqueues a standalone message on the session's input
 * stream. The provider consumes exactly ONE input-stream message per turn, so
 * a pushed message becomes its own model turn — correct for live steering,
 * wrong for hook-generated context (a push that lands after the current turn
 * ends displaces the user's next real message by one queue position).
 *
 * `queueFrameworkContext` is the channel for hook-generated context
 * (e.g. SubagentStop `injectContext`): the text is held in session state and
 * prepended to the NEXT real outbound user message, so it rides along with —
 * never instead of — what the user actually sends. Optional because narrow
 * stubs (tests, deferred-parent proxies) may only implement the push channel;
 * callers fall back to `pushUserMessage` when absent.
 */
export interface InputStreamRef {
  pushUserMessage(content: string): void;
  queueFrameworkContext?(text: string): void;
}
