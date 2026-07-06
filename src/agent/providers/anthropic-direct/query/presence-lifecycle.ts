/**
 * Presence-file lifecycle for {@link AnthropicDirectProvider.query}.
 *
 * Owns the top-level-session guard, best-effort presence write, and synchronous
 * cleanup handler registration. The caller owns the provider's
 * `_presenceSessionId` slot and threads it through explicitly so provider state
 * is updated exactly once per instance.
 *
 * @module agent/providers/anthropic-direct/query/presence-lifecycle
 */

import {
  writePresenceFile,
  removePresenceFileSync,
  type RuntimeStateSource,
} from '../../../awareness/index.js';
import { actorFromDepth } from '../../../session/session-identity.js';

export interface PresenceLifecycleArgs {
  depth: number | undefined;
  parentSessionId: string | undefined;
  sessionId: string | undefined;
  currentPresenceSessionId: string | null;
  runtimeStateSource: RuntimeStateSource;
  surface: string;
  cwd: string | undefined;
  providerName: string;
  model: string;
}

/**
 * Write top-level session presence once per provider and return the updated
 * provider `_presenceSessionId` slot.
 */
export function registerPresenceLifecycle(args: PresenceLifecycleArgs): string | null {
  // Phase 2 — Presence file lifecycle (top-level sessions only).
  // Guard: only write once per provider instance (not once per turn).
  // Top-level = depth is 0 or undefined (parentSessionId absent).
  const isTopLevel =
    (args.depth === undefined || args.depth === 0) &&
    args.parentSessionId === undefined;
  if (isTopLevel && args.sessionId !== undefined && args.currentPresenceSessionId === null) {
    const sessionId = args.sessionId;
    const workspace = args.runtimeStateSource.getWorkspace();
    // Fire-and-forget — presence is best-effort.
    void writePresenceFile({
      sessionId,
      surface: args.surface,
      // Presence is written only under the top-level gate above, so depth is
      // 0/undefined here ⇒ 'main'. Derived (not hardcoded) to stay correct
      // if that gate is ever changed.
      actor: actorFromDepth(args.depth),
      cwd: args.cwd ?? process.cwd(),
      startedAt: new Date().toISOString(),
      model: { provider: args.providerName, name: args.model },
      workspace,
      pid: process.pid,
    });
    // Sync cleanup on process exit (cannot await in exit handler).
    process.once('exit', () => { removePresenceFileSync(sessionId); });
    // Best-effort cleanup on signals — fires before 'exit'.
    process.once('SIGINT', () => { removePresenceFileSync(sessionId); process.exit(130); });
    process.once('SIGTERM', () => { removePresenceFileSync(sessionId); process.exit(143); });
    return sessionId;
  }

  return args.currentPresenceSessionId;
}
