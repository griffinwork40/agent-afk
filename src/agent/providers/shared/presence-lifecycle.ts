/**
 * Shared presence-file lifecycle for provider `query()` implementations.
 *
 * Owns three concerns, in one place so both providers cannot drift:
 *   1. the top-level-session guard ({@link isTopLevelSession}),
 *   2. resolving the session id presence must advertise
 *      ({@link resolveTopLevelSessionId}),
 *   3. the best-effort presence write, keyed on the advertised id
 *      ({@link registerPresenceLifecycle}).
 *
 * Exit/signal cleanup deliberately does NOT live here — it is process-scoped,
 * not session-scoped, and lives in `./presence-signals.ts`.
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
import { debugLog } from '../../../utils/debug.js';
import {
  registerPresenceCleanup,
  unregisterPresenceCleanup,
} from './presence-signals.js';

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
  /**
   * The provider instance's user-facing surface (`'cli' | 'daemon' |
   * 'telegram'`). Gates minting only — see {@link PRESENCE_MINT_SURFACES}.
   */
  surface: string | undefined;
  /** The provider instance's memoized mint, or `null` if it has not minted. */
  memoized: string | null;
}

/**
 * Surfaces whose *fresh* (non-resumed) sessions are worth advertising.
 *
 * Contract: only two readers of presence files exist, and both are Telegram —
 * `bot.ts` auto-subscribe filters `surface === 'cli' && afk === true`, and the
 * `/watch` no-argument listing in `watch.ts` renders live records. A minted
 * advertisement on any other surface is invisible to every reader while still
 * costing a file plus a cleanup registration, which is how a long-running
 * daemon accrued one stale live-looking record per scheduled task (12 tasks ⇒
 * 12 records). Gating the MINT — not the write — keeps the pre-existing
 * contract intact: a session carrying an explicit id (`--resume`) still
 * advertises on every surface, which `telegram/presence-surface.test.ts` pins
 * for `cli`, `daemon`, and `telegram` alike.
 */
export const PRESENCE_MINT_SURFACES: ReadonlySet<string> = new Set(['cli']);

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
 * on a {@link PRESENCE_MINT_SURFACES} surface with no explicit id gets a mint,
 * and that mint is memoized so it stays stable across turns on the same
 * provider instance.
 *
 * Invariant: the memoized mint survives `AgentSession.reset()` (`/clear`) on
 * purpose, so the post-clear session keeps its id. Two mechanisms depend on it.
 * (1) `LedgerLifecycle.seal()` resets its own latch precisely "so the same
 * instance is reused cleanly across a reset() cycle" and writes a delimiting
 * `closed`/`reset` record, so one ledger file legitimately holds both
 * conversations. (2) The AFK elicitation channel and the remote-abort watcher
 * are bound to the id captured at `/afk on` (`cli/afk-mode-toggle.ts`), and the
 * `afk` marker lives on THAT id's presence file — minting a new id here would
 * leave the operator's phone relay and remote `/abort` bound to an id nothing
 * writes to any more, silently, which is the exact failure mode this module's
 * header forbids. A caller that genuinely wants a new identity constructs a new
 * provider instance rather than resetting one.
 *
 * Contract: never *mints* for a fork. An explicit parent id still wins via the
 * precedence above — `subagent.ts` sets `resume: parent.sessionId` on every
 * child config, so a fork resolves to its parent's id, which is exactly the id
 * fork query construction already used before this helper existed. Presence
 * stays blocked for forks by the independent `isTopLevelSession` re-gate in
 * {@link registerPresenceLifecycle}, so a fork never advertises.
 */
export function resolveTopLevelSessionId(
  args: SessionIdResolutionArgs,
): SessionIdResolution {
  const explicit = args.sessionId ?? args.resume;
  if (explicit !== undefined) return { id: explicit, memoized: args.memoized };

  if (!isTopLevelSession(args.depth, args.parentSessionId)) {
    return { id: undefined, memoized: args.memoized };
  }

  // Mint only for a surface some presence consumer actually reads. Returning
  // `undefined` here restores the pre-gate behavior for every other surface:
  // query construction keeps its own per-call mint and nothing is advertised.
  if (args.surface === undefined || !PRESENCE_MINT_SURFACES.has(args.surface)) {
    return { id: undefined, memoized: args.memoized };
  }

  const minted = args.memoized ?? randomUUID();
  return { id: minted, memoized: minted };
}

/**
 * Write top-level session presence and return the updated `_presenceSessionId`
 * slot. Writes once per advertised *id* — not once per turn, and not once per
 * provider instance.
 *
 * Per-instance state (not per-process) on purpose: one OS process can
 * legitimately host several concurrent top-level sessions, and each must
 * advertise its own presence file.
 *
 * History: the guard here used to be `currentPresenceSessionId === null`, i.e.
 * once per provider instance for the life of the process. The REPL memoizes
 * provider instances per model family (`cli/commands/interactive/provider-factory.ts`),
 * so `/resume` builds a NEW session on an instance that had already advertised
 * the previous session's id: the resumed session was never advertised, while the
 * closed session's file — `afk: true` if the operator had toggled it — survived
 * and kept the Telegram watcher tailing a ledger nothing writes to any more.
 * Keying on the id instead makes the advertised id follow the live session.
 */
export function registerPresenceLifecycle(args: PresenceLifecycleArgs): string | null {
  const sessionId = args.sessionId;
  if (!isTopLevelSession(args.depth, args.parentSessionId) || sessionId === undefined) {
    return args.currentPresenceSessionId;
  }
  // Already advertising this exact id — presence is per session, not per turn.
  if (args.currentPresenceSessionId === sessionId) return sessionId;

  const previous = args.currentPresenceSessionId;
  if (previous !== null) {
    // Ordered-operation constraint (governed by this module's header invariant):
    // drop the stale record BEFORE writing the new one. A crash between the two
    // steps must leave ZERO presence records — a loud absence the watcher
    // reports honestly — rather than two live-looking records, one of which
    // points at a ledger nothing writes to. Silent misdirection is strictly
    // worse than absence, so absence is the safe intermediate state.
    debugLog(`⚑ presence: advertised id changed ${previous} → ${sessionId} — rewriting`);
    unregisterPresenceCleanup(previous);
    removePresenceFileSync(previous);
  }

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
  // Cleanup on process exit/signal is owned by the process-level registry —
  // one set of listeners per process, not three per session, and it never
  // pre-empts a surface's own graceful shutdown. See ./presence-signals.ts.
  registerPresenceCleanup(sessionId);
  return sessionId;
}
