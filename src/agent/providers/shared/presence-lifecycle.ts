/**
 * Shared presence-file lifecycle for provider `query()` implementations.
 *
 * Owns three concerns, in one place so both providers cannot drift:
 *   1. the top-level-session guard ({@link isTopLevelSession}),
 *   2. resolving the session id presence must advertise
 *      ({@link resolveTopLevelSessionId}),
 *   3. the best-effort presence write + cleanup-handler registration
 *      ({@link registerPresenceLifecycle}).
 *
 * Invariant: the id written into the presence file MUST be the same id used for
 * that session's ledger directory (`~/.afk/state/sessions/<id>/events.jsonl`).
 * The Telegram watcher resolves the ledger path FROM the presence file's
 * sessionId, so an id mismatch makes auto-subscribe "succeed" while tailing a
 * ledger that does not exist — a silent failure strictly worse than the loud
 * absence of a presence file. Callers therefore MUST pass the id returned by
 * {@link resolveTopLevelSessionId} to BOTH this module and their query
 * construction, so the two agree by construction rather than by coincidence.
 *
 * History: presence was previously gated on `config.sessionId`, which is
 * populated only under `--resume`/`--continue`. Every fresh top-level CLI
 * session therefore wrote NO presence file, leaving the Telegram bot's
 * presence-driven auto-subscribe loop structurally blind to it and making
 * bidirectional AFK (inline Yes/No buttons on the operator's phone) impossible
 * for any non-resumed session. The real id was minted downstream of the gate,
 * inside query construction, from the *different* `config.resume` field.
 *
 * @module agent/providers/shared/presence-lifecycle
 */

import { randomUUID } from 'node:crypto';
import {
  writePresenceFile,
  removePresenceFileSync,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { actorFromDepth } from '../../session/session-identity.js';

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
 * Top-level = depth is 0 or undefined AND no parent session id. Subagent forks
 * always receive `depth: parentDepth + 1` (≥ 1) and a `parentSessionId`, so
 * they are structurally excluded — forks must never advertise presence, and
 * must never share a parent's minted session id.
 */
export function isTopLevelSession(
  depth: number | undefined,
  parentSessionId: string | undefined,
): boolean {
  return (depth === undefined || depth === 0) && parentSessionId === undefined;
}

export interface SessionIdResolutionArgs {
  /** `config.sessionId` — populated only under `--resume`/`--continue`. */
  sessionId: string | undefined;
  /** `config.resume` — the id a continuing turn threads back in. */
  resume: string | undefined;
  depth: number | undefined;
  parentSessionId: string | undefined;
  /** The provider instance's memoized mint, or `null` if it has not minted. */
  memoized: string | null;
}

export interface SessionIdResolution {
  /**
   * The id to use for BOTH presence and query construction. `undefined` only
   * for forks with no explicit id — preserving the pre-existing behavior where
   * the query mints its own id per call.
   */
  id: string | undefined;
  /** The value the caller must store back into its memo slot. */
  memoized: string | null;
}

/**
 * Resolve the session id a top-level session should use, minting one exactly
 * once per provider instance when the caller supplied none.
 *
 * Precedence: an explicit id (`config.sessionId`, then `config.resume`) always
 * wins, so resume semantics are bit-for-bit unchanged. Only a top-level session
 * with no explicit id gets a mint, and that mint is memoized so it stays stable
 * across turns on the same provider instance.
 *
 * Contract: never mints for a fork — returns `id: undefined` there, so fork
 * query construction keeps its existing per-call mint and cannot inherit a
 * parent's id (which would collide on the ledger directory).
 */
export function resolveTopLevelSessionId(
  args: SessionIdResolutionArgs,
): SessionIdResolution {
  const explicit = args.sessionId ?? args.resume;
  if (explicit !== undefined) return { id: explicit, memoized: args.memoized };

  if (!isTopLevelSession(args.depth, args.parentSessionId)) {
    return { id: undefined, memoized: args.memoized };
  }

  const minted = args.memoized ?? randomUUID();
  return { id: minted, memoized: minted };
}

/**
 * Write top-level session presence once per provider instance and return the
 * updated `_presenceSessionId` slot.
 *
 * Per-instance (not per-process) on purpose: one OS process can legitimately
 * host several concurrent top-level sessions, and each must advertise its own
 * presence file.
 */
export function registerPresenceLifecycle(args: PresenceLifecycleArgs): string | null {
  // Guard: only write once per provider instance (not once per turn).
  if (
    isTopLevelSession(args.depth, args.parentSessionId) &&
    args.sessionId !== undefined &&
    args.currentPresenceSessionId === null
  ) {
    const sessionId = args.sessionId;
    const workspace = args.runtimeStateSource.getWorkspace();
    // Fire-and-forget — presence is best-effort and must never throw into the
    // query path.
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
