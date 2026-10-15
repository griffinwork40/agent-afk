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
 * Known gap (deliberately not closed here): this module keys presence off ONE
 * provider instance's memo, so it cannot see a second instance. A cross-family
 * `/model` swap builds a fresh inner provider whose memo starts `null`
 * (`router/provider-router.ts`), which mints a second id and advertises a
 * second record, while the swallowed `session.init` leaves the ledger pinned to
 * the pre-swap id — so the orphan advertises a directory nothing creates.
 * Bounded, and fails closed on both readers that could act on it: the orphan
 * carries `afk: false`, and auto-subscribe requires `afk === true`
 * (`telegram/bot.ts`), while `/watch` selection re-checks `ledgerExists`
 * (`telegram/watch.ts`). Closing it means threading the live session id into
 * the router's inner construction so every inner resolves through the
 * explicit-id branch above; that touches swap/init semantics this module does
 * not own, so it is tracked separately rather than bundled here.
 *
 * @module agent/providers/shared/presence-lifecycle
 */

import { randomUUID } from 'node:crypto';
import {
  writePresenceFileSync,
  removePresenceFileSync,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { actorFromDepth } from '../../session/session-identity.js';
import { ownProcessStartedAt, ownProcessStartTicks } from '../../process-liveness.start-time.js';
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
   * 'telegram'`). Controls whether presence is advertised via
   * {@link PRESENCE_ADVERTISE_SURFACES}; a stable id is minted for all
   * top-level surfaces regardless.
   */
  surface: string | undefined;
  /** The provider instance's memoized mint, or `null` if it has not minted. */
  memoized: string | null;
}

/**
 * Surfaces whose *fresh* (non-resumed) sessions are worth advertising with a
 * presence file.
 *
 * Contract: three readers of presence files exist. Two are Telegram and both
 * ignore non-`cli` fresh sessions — `bot.ts` auto-subscribe filters
 * `surface === 'cli' && afk === true`, and the `/watch` no-argument listing in
 * `watch.ts` filters `surface !== 'telegram'` (so it would render a `daemon`
 * record, but selecting one fails closed on `ledgerExists`). The third is
 * `worktree-sweep.ts`, which reads presence with NO surface filter to protect a
 * worktree hosting a live session from being reaped.
 *
 * **IMPORTANT**: This set gates the PRESENCE WRITE (via the `shouldAdvertise`
 * flag on {@link SessionIdResolution}), NOT the id mint. Every top-level
 * session on every surface now receives a stable minted id so that tool
 * dispatchers (image_generate, workspace_*, state_*, bash capture) always have
 * a sessionId to attribute work to, and `get_runtime_state` / the `# Environment`
 * block always show the resolved id — even on `telegram` and `daemon` surfaces
 * (fix for #2353). The worktree-sweep protection and the per-task stale-record
 * problem are unaffected: those depend on presence FILES, not on whether an id
 * was minted. Widening the mint without widening the write therefore adds no
 * reap-protection to daemon tasks (that deliberate decision is unchanged) and
 * accrues no extra presence files in a long-running daemon.
 *
 * A session carrying an explicit id (`--resume`) still advertises on every
 * surface, which `telegram/presence-surface.test.ts` pins for `cli`, `daemon`,
 * and `telegram` alike — that path is unaffected by this set.
 */
export const PRESENCE_ADVERTISE_SURFACES: ReadonlySet<string> = new Set(['cli']);

export interface SessionIdResolution {
  /**
   * The id to use for BOTH presence and query construction. `undefined` only
   * for forks with no explicit id — preserving the pre-existing behavior where
   * the query mints its own id per call.
   */
  id: string | undefined;
  /** The value the caller must store back into its memo slot. */
  memoized: string | null;
  /**
   * Whether a presence file should be written for this session. True when the
   * surface is in {@link PRESENCE_ADVERTISE_SURFACES} or when the caller
   * supplied an explicit id (`--resume`/`--continue`). Callers MUST gate the
   * {@link registerPresenceLifecycle} call on this flag rather than calling it
   * unconditionally — doing so would accrue one stale file per daemon task and
   * hand daemon sessions worktree-sweep protection they have never had.
   */
  shouldAdvertise: boolean;
}

/**
 * Resolve the session id a top-level session should use, minting one exactly
 * once per provider instance when the caller supplied none.
 *
 * Precedence: an explicit id (`config.sessionId`, then `config.resume`) always
 * wins, so resume semantics are bit-for-bit unchanged. Every top-level session
 * (regardless of surface) receives a minted id that is memoized so it stays
 * stable across turns on the same provider instance. The returned
 * `shouldAdvertise` flag controls whether a presence FILE is written — only
 * surfaces in {@link PRESENCE_ADVERTISE_SURFACES} or sessions carrying an
 * explicit id write a file. Decoupling mint from advertise means non-CLI
 * surfaces (telegram, daemon) now get a stable id for tool attribution
 * (image_generate, workspace_*, state_*, bash capture, get_runtime_state) while
 * the long-running-daemon stale-file and reap-protection concerns remain
 * unchanged (fix for #2353).
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
  if (explicit !== undefined) {
    return { id: explicit, memoized: args.memoized, shouldAdvertise: true };
  }

  if (!isTopLevelSession(args.depth, args.parentSessionId)) {
    return { id: undefined, memoized: args.memoized, shouldAdvertise: false };
  }

  // Mint a stable id for every top-level session — regardless of surface —
  // so tool dispatchers always have attribution context and get_runtime_state
  // always reports the resolved id. Whether to WRITE a presence file is a
  // separate concern controlled by PRESENCE_ADVERTISE_SURFACES (fix for #2353).
  const minted = args.memoized ?? randomUUID();
  const shouldAdvertise =
    args.surface !== undefined && PRESENCE_ADVERTISE_SURFACES.has(args.surface);
  return { id: minted, memoized: minted, shouldAdvertise };
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
  // Ordered-operation constraint: this write must be durable before `query()`
  // continues. Both providers expose a synchronous `close()`, so an async write
  // issued here has no handle any caller can await and outlives the turn that
  // started it — which raced host teardown of a scratch `AFK_HOME` (ENOTEMPTY,
  // the write recreating `presence/` mid-rmdir) and let an immediate `/afk on`
  // no-op on ENOENT before the file existed. Sync is cheap here: one ~300-byte
  // write, once per advertised id, never once per turn. Never throws.
  writePresenceFileSync({
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
    // Lets readers detect a recycled pid (presence.liveness.ts).
    pidStartedAt: ownProcessStartedAt(),
    // Linux: clock-step-immune identity, compared in preference to the epoch.
    pidStartTicks: ownProcessStartTicks(),
  });
  // Cleanup on process exit/signal is owned by the process-level registry —
  // one set of listeners per process, not three per session, and it never
  // pre-empts a surface's own graceful shutdown. See ./presence-signals.ts.
  registerPresenceCleanup(sessionId);
  return sessionId;
}
