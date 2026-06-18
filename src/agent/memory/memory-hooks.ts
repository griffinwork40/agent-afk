/**
 * Memory lifecycle hooks.
 *
 * SessionEnd hook writes a session record to the MemoryStore. The record
 * is first appended to the JSONL write-ahead log (atomic POSIX append),
 * then written to SQLite. If SQLite fails, the WAL entry is replayed on
 * next MemoryStore construction.
 *
 * @module agent/memory/memory-hooks
 */

import type { HookHandler } from '../hooks.js';
import { MemoryStore } from './memory-store.js';
import { deriveActor } from '../session/session-identity.js';

export function createMemorySessionEndHook(
  store: MemoryStore,
  surface: string = 'cli',
): HookHandler {
  return (context) => {
    if (context.event !== 'SessionEnd') return {};
    // Subagent guard: a forked child session inherits the parent's registry
    // (subagent.ts threads it into the child config), so its teardown fires
    // this hook too. Skip it — otherwise every subagent writes a
    // start/end session pair to the store, polluting it with worker
    // sessions the user never started. Top-level sessions have no
    // parentSessionId and proceed normally.
    if (context.parentSessionId) return {};
    try {
      const sessionId = context.sessionId;
      if (sessionId) {
        // `actor` is DERIVED from the parent linkage rather than hardcoded:
        // past the subagent guard above, `parentSessionId` is absent so this
        // resolves to 'main', but the derivation keeps the row correct if that
        // guard is ever relaxed to record worker sessions.
        store.startSession({ session_id: sessionId, surface, actor: deriveActor(context.parentSessionId) });
        store.endSession(sessionId, context.reason ?? 'session ended', 'completed');
      }
    } catch {
      // SessionEnd errors are non-blocking — the session still ends.
      // WAL has the entry if SQLite failed.
    }
    return {};
  };
}
