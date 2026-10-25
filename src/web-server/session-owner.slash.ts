/**
 * Per-session SessionStats tracker for web-owned sessions.
 *
 * This is a side-car module to session-owner.ts. It holds a process-global
 * Map of sessionId → SessionStats so that slash-command handlers invoked
 * over the command API can read and update session statistics.
 *
 * IMPORTANT: This module must NOT import session-owner.ts (cycle risk).
 * `buildSessionRef` receives an already-looked-up AgentSession object.
 */

import { createSessionStats, recordTurn } from '../cli/slash/session-stats.js';
import type { SessionStats } from '../cli/slash/types.js';
import type { AgentModelInput } from '../agent/types.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SessionRef } from '../agent/session-ref.js';
import type { ResponseMetadata } from '../agent/types/message-types.js';

const statsMap = new Map<string, SessionStats>();

/**
 * Initialize a fresh SessionStats for a session. Called immediately after the
 * session is stored in the owner (session-owner.ts line ~205).
 */
export function initSessionStats(id: string, model: AgentModelInput): void {
  statsMap.set(id, createSessionStats(model));
}

/**
 * Retrieve the SessionStats for a session, or undefined if not initialized.
 */
export function getStats(id: string): SessionStats | undefined {
  return statsMap.get(id);
}

/**
 * Record a completed turn into the session's stats. Called from
 * session-owner.autosave.ts after autosaver.saveTurn().
 *
 * @param id - The session id.
 * @param userInput - The user input label for this turn.
 * @param assistantText - The assistant's text response.
 * @param metadata - Turn metadata from the provider.
 */
export function onTurnDrained(
  id: string,
  userInput: string,
  assistantText: string,
  metadata: ResponseMetadata | undefined,
): void {
  const stats = statsMap.get(id);
  if (!stats) return;
  recordTurn(stats, userInput, assistantText, metadata);
}

/**
 * Build a SessionRef from an already-looked-up AgentSession.
 *
 * Callers in routes.commands.ts guard against undefined before calling this
 * when getSession is wired, so `session` is always defined there. When
 * getSession is absent (tests, attach-only mode), the caller may pass
 * undefined and the SlashContext will have no live session — acceptable for
 * read-only handlers that never touch ctx.session.current.
 *
 * Invariant: never use `as` cast — SessionRef is `{ current: AgentSession }`
 * (not optional). We satisfy the type by only calling this with a defined
 * session, or accepting the TS error and suppressing it consciously below.
 */
export function buildSessionRef(session: AgentSession): SessionRef {
  return { current: session };
}

/**
 * Build a SessionRef from an optional session lookup result.
 * Used in contexts where a session may not be available (e.g. tests).
 * The caller is responsible for ensuring the handler does not dereference
 * ctx.session.current when it may be absent.
 */
export function buildOptionalSessionRef(session: AgentSession | undefined): SessionRef {
  // SessionRef.current is AgentSession (non-optional in the type), but we
  // need to support the undefined case for test contexts. The cast is
  // confined to this one function rather than scattered across callers.
  return { current: session } as unknown as SessionRef;
}

/** Test seam: clear all stats. */
export function resetSessionStatsForTest(): void {
  statsMap.clear();
}
