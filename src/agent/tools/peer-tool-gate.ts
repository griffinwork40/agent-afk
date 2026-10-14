/**
 * Top-level-only gate for the peer-session messaging tools
 * (`list_sessions`, `send_to_session`).
 *
 * Invariant: ONE predicate decides both what a dispatcher ADVERTISES
 * (`SessionToolDispatcher.toolDefs`) and what it will EXECUTE (the
 * pre-dispatch gate chain). Hiding a tool from the schema alone is not
 * enforcement: `CHILD_ALLOWED_TOOLS` contains every builtin name and the
 * handlers are registered unconditionally, so a child that names a hidden
 * tool would otherwise reach its handler.
 *
 * "Child" = any forked session. `parentSessionId` is the usual signal, but a
 * skill-forked descendant whose stub parent carries no session id has none;
 * `subagentId` is stamped on EVERY fork by `assembleChildConfig`
 * (subagent/fork-child-config.ts) and never on a top-level session, so either
 * signal marks the dispatcher as a child.
 *
 * @module agent/tools/peer-tool-gate
 */

import { PEER_TOOL_NAMES } from './schemas.peer.js';

const PEER_TOOL_SET: ReadonlySet<string> = new Set<string>(PEER_TOOL_NAMES);

/** Fork signals a dispatcher carries. */
export interface ChildSessionSignals {
  parentSessionId: string | undefined;
  subagentId: string | undefined;
}

/** True when the dispatcher belongs to a forked (non-top-level) session. */
export function isChildDispatcherSession(s: ChildSessionSignals): boolean {
  return s.parentSessionId !== undefined || s.subagentId !== undefined;
}

/** True when `toolName` must be hidden from AND refused to this session. */
export function isPeerToolBlocked(toolName: string, s: ChildSessionSignals): boolean {
  return PEER_TOOL_SET.has(toolName) && isChildDispatcherSession(s);
}

/** Model-visible reason returned when a child calls a peer tool. */
export function peerToolChildDenial(toolName: string): string {
  return (
    `Tool "${toolName}" is top-level only: sub-agent sessions cannot list or ` +
    `message peer sessions. Return your findings to your caller instead.`
  );
}
