/**
 * Memory lifecycle hooks.
 *
 * SessionEnd hook writes a session record to the MemoryStore. The record
 * is first appended to the JSONL write-ahead log (atomic POSIX append),
 * then written to SQLite. If SQLite fails, the WAL entry is replayed on
 * next MemoryStore construction.
 *
 * createChildMemoryHotBlockHook: PreToolUse hook that prevents forked
 * sub-agents from writing to the "hot" memory target (HOT.md). Sub-agents
 * CAN call memory_update with target:"fact" — fact writes are safe because
 * they go to the searchable SQLite archive and do not affect any live
 * session's system prompt. But target:"hot" rewrites HOT.md which is
 * injected verbatim into every future session, including the parent: a
 * sub-agent mutating the parent's ambient context is too high a blast
 * radius for unsupervised fan-out.
 *
 * @module agent/memory/memory-hooks
 */

import type { HookDecision, HookHandler } from '../hooks.js';
import { MemoryStore } from './memory-store.js';
import { deriveActor } from '../session/session-identity.js';
import { isSubagentContext } from '../hooks/hook-utils.js';

/**
 * Build a PreToolUse hook that blocks `memory_update` with `target: "hot"` in
 * forked sub-agent sessions (those with a `parentSessionId`).
 *
 * Rationale: sub-agents are now allowed to call `memory_update` so they can
 * persist facts (target:"fact") across sessions. The fact archive is safe
 * because it is purely additive and searchable; no live session's system
 * prompt is affected. However, target:"hot" rewrites HOT.md which is injected
 * verbatim into every future session's system prompt — including the parent
 * session's. A sub-agent mutating the parent's ambient context without
 * supervision is too high a blast radius.
 *
 * The hook is registered globally in default-hook-registry.ts. On non-subagent
 * sessions (parentSessionId absent) the hook is a no-op so parent sessions are
 * unaffected.
 *
 * Returns:
 * - `{ decision: 'block', injectContext }` for a sub-agent hot-write → the
 *   dispatcher throws HookBlockedError and returns `is_error: true` with an
 *   explanation that directs the model to use target:"fact" instead.
 * - `{}` for anything else (non-subagent, non-memory_update, target:"fact").
 */
export function createChildMemoryHotBlockHook(): HookHandler {
  return (context): HookDecision => {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'memory_update') return {};
    // Only apply to forked sub-agent sessions.
    if (!isSubagentContext(context)) return {};

    // Inspect the `target` field from the tool input.
    const input = context.input as { target?: string } | undefined;
    const target = input?.target;

    if (target !== 'hot') return {};

    // Block the hot write and inject guidance.
    return {
      decision: 'block',
      reason: 'Sub-agent sessions may not write to target:"hot".',
      injectContext:
        'Sub-agent sessions may not write to target:"hot" — hot memory rewrites HOT.md, ' +
        'which is injected into every future session\'s system prompt. ' +
        'Use target:"fact" to persist findings to the searchable SQLite archive instead.',
    };
  };
}

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
    if (isSubagentContext(context)) return {};
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
