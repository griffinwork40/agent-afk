/**
 * Telegram chat session management
 * @module telegram/session-manager
 */

import type { IAgentSession, AgentConfig, AgentModelInput, ThinkingConfig, EffortLevel, ResponseMetadata } from '../agent/types.js';
import { injectHotMemory } from '../agent/memory/index.js';
import { injectCompanionPrimer } from '../agent/companion/index.js';
import { setElicitationRoute, clearElicitationRoute } from './elicitation-route-registry.js';
import { runTelegramReconcile } from '../agent/manifest/startup-reconcile.js';
// Shared session-persistence utilities. These live under src/cli/ but are
// surface-agnostic (pure functions over SessionStats / sidecar files); the
// Telegram bot reuses them so a chat session lands in the SAME
// ~/.afk/state/sessions/<sessionId>.json store the CLI's /resume reads. A
// future cleanup could relocate them to a neutral module — for now this is the
// only telegram→cli edge and there is no import cycle (they never import telegram).
import { createSessionStats, recordTurn } from '../cli/slash/session-stats.js';
import { saveSession, loadSession, listSessions } from '../cli/session-store.js';
import { resumeConfigFor } from '../cli/resume-session.js';
import type { SessionStats } from '../cli/slash/types.js';
import { type TelegramRoute, routeKey } from './route.js';
import { sessionRegistry, type SessionRegistry } from '../agent/session/session-registry.js';
import { ensureRegistryHandle, archiveRegistryHandle } from './session-manager.registry.js';
import { resolveActiveRouteForChat } from './session-manager.active-route.js';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Public methods that used to take a bare `chatId: number` now take a route
 * target. A bare `number` is accepted as shorthand for that chat's General
 * topic — `{ chatId: n }` — so every pre-topics caller (and the entire existing
 * telegram test suite) is byte-identical: `routeKey({ chatId: n })` === the
 * legacy `String(n)` key. A real topic passes a full `TelegramRoute` with a
 * `threadId`, which keys as `${chatId}:${threadId}` and isolates that topic's
 * session/queue/elicitation from every other topic in the same chat.
 */
export type RouteTarget = TelegramRoute | number;

/** Normalize a RouteTarget to a full route. A bare number is the General topic. */
function toRoute(target: RouteTarget): TelegramRoute {
  return typeof target === 'number' ? { chatId: target } : target;
}

/**
 * Session data for persistence
 */
export interface SessionData {
  /**
   * Telegram chat id — retained for provenance and outbound sends
   * (`stats.telegramChatId`, `bot.telegram.sendMessage(chatId, …)`). The
   * in-memory maps and the on-disk sidecar are keyed by the ROUTE (see
   * `routeKey`), not this field: General topics key as `String(chatId)`
   * (unchanged on disk for existing users), a real topic as `${chatId}:${threadId}`.
   */
  chatId: number;
  /**
   * Topic thread id when this session belongs to a non-General topic; absent
   * for General / topics-off. Persisted so a per-topic sidecar round-trips its
   * route on reload (the routeKey is otherwise recoverable only from the filename).
   */
  threadId?: number;
  model: AgentModelInput;
  createdAt: string;
  lastActivity: string;
  /**
   * SDK session id of the live AgentSession, captured once the session
   * initializes and a turn is recorded. Persisted so it survives bot restart
   * and so the chat's conversation can be located in the shared session store.
   */
  sessionId?: string;
  /**
   * Per-chat working directory override. When set, the AgentSession (and
   * its forked subagents) operate in this directory rather than the
   * bot-global `botCwd`. Set via the `/cd` slash command.
   *
   * Persisted to disk so the cwd survives bot restart.
   */
  cwd?: string;
}

/**
 * One resumable conversation for a chat, surfaced by the `/sessions` switcher.
 * Derived from the shared sidecar store (telegram sidecars for this chatId).
 */
export interface ChatSessionInfo {
  /** SDK session id — the resume target passed to `/switch`. */
  sessionId: string;
  /** Human-readable name (auto or via `/name`), when set. */
  name?: string;
  model: AgentModelInput;
  /** Recorded turns in the conversation. */
  turns: number;
  /** Sidecar `savedAt` (ms) — most-recent activity; list is sorted by this desc. */
  lastActive: number;
  /** True when this is the chat's currently-active conversation. */
  active: boolean;
}

/**
 * Session manager options
 */
export interface SessionManagerOptions {
  /** Directory to store session data */
  dataDir?: string;

  /**
   * Default model for new sessions. Accepts any harness model input —
   * Claude short aliases, raw `claude-*` ids, OpenAI model ids.
   */
  defaultModel?: AgentModelInput;

  /** API key for the active provider (Anthropic or OpenAI-compatible). May be empty when using OAuth state. */
  apiKey: string;

  /** SDK settingSources (e.g. ['user','project']) so sessions load native slash commands/skills */
  settingSources?: ('user' | 'project')[];

  /** Default thinking config threaded into every spawned session. */
  thinking?: ThinkingConfig;

  /** Default effort level threaded into every spawned session. */
  effort?: EffortLevel;

  /**
   * Bot-global working directory fallback. Used as the cwd for any chat
   * that has not set a per-session override via `/cd`. Typically sourced
   * from the `AFK_TELEGRAM_CWD` env var in the bot bootstrap.
   *
   * Per-session `data.cwd` (set via `/cd`) takes precedence over this.
   */
  botCwd?: string;

  /** Factory function to create agent sessions */
  createSession: (config: AgentConfig) => Promise<IAgentSession>;

  /**
   * Optional session registry override for test isolation. Defaults to the
   * process-wide `sessionRegistry` singleton when not provided.
   */
  registry?: SessionRegistry;

  /**
   * Called fire-and-forget when a new session is created and a wave-manifest
   * resumption offer is available. The caller (TelegramBot) is responsible for
   * forwarding the offer text to the chat. Never invoked when no offers exist.
   */
  onResumptionOffer?: (route: TelegramRoute, text: string) => void;
}

/**
 * Manages Telegram chat sessions.
 *
 * Invariant: every live-session map is keyed by `routeKey(route)`, NOT a bare
 * chatId. General / topics-off routes normalize to `String(chatId)` (so an
 * existing single-session user is byte-identical to the pre-topics bot), while a
 * real Telegram topic keys as `${chatId}:${threadId}` — giving one fully-isolated
 * AgentSession per topic inside a single chat. Public methods accept a
 * `RouteTarget` (a full `TelegramRoute`, or a bare `number` treated as that chat's
 * General topic) and compute the routeKey internally.
 */
export class SessionManager {
  private sessions = new Map<string, IAgentSession>();
  /** In-flight creation promises — prevent duplicate session spawns on concurrent messages (per route). */
  private pendingSessions = new Map<string, Promise<IAgentSession>>();
  private sessionData = new Map<string, SessionData>();
  /**
   * Per-route accumulating session stats (turns, totals, name, sessionId).
   * Recorded on each completed turn and written to the shared session store
   * so the CLI can `--resume <name>` a Telegram conversation. Reset whenever
   * the underlying AgentSession is torn down (/clear, model switch, /cd) so a
   * fresh sessionId and name are captured for the rebuilt session.
   */
  private sessionStats = new Map<string, SessionStats>();
  /**
   * Routes that have already logged an autosave failure this conversation.
   * Per-turn autosave is best-effort, but a persistent failure (EACCES,
   * ENOSPC) would otherwise be silently swallowed every turn while the user
   * assumes the chat is resumable from the CLI. Log the FIRST failure per route
   * and stay quiet afterwards; the entry is cleared on _resetStats so a fresh
   * conversation gets a fresh warning.
   */
  private autosaveFailureLogged = new Set<string>();
  /**
   * Routes with a staged `/switch` resume target (SDK session id). Consumed once
   * by the next getSession() to build the rebuilt session with `config.resume`
   * so it continues the chosen prior conversation. Cleared on any teardown
   * (/clear, model switch, /cd) via _resetStats so those start fresh, never
   * resuming a stale target.
   */
  private pendingResume = new Map<string, string>();
  private options: Required<Omit<SessionManagerOptions, 'createSession' | 'settingSources' | 'thinking' | 'effort' | 'botCwd' | 'registry' | 'onResumptionOffer'>> &
    Pick<SessionManagerOptions, 'createSession' | 'settingSources' | 'thinking' | 'effort' | 'botCwd' | 'registry' | 'onResumptionOffer'>;

  constructor(options: SessionManagerOptions) {
    this.options = {
      dataDir: options.dataDir || './data/telegram-sessions',
      // Default to the `medium` capability TIER (not the fixed `'sonnet'` identity
      // alias) so a rebound `medium` changes the default; matches CLI getModel().
      defaultModel: options.defaultModel || 'medium',
      apiKey: options.apiKey,
      settingSources: options.settingSources,
      thinking: options.thinking,
      effort: options.effort,
      botCwd: options.botCwd,
      createSession: options.createSession,
      registry: options.registry,
      onResumptionOffer: options.onResumptionOffer,
    };
  }

  /**
   * Get existing session for a route without creating one.
   * Used e.g. to read SDK-native slash commands for /help.
   */
  getSessionIfExists(target: RouteTarget): IAgentSession | undefined {
    return this.sessions.get(routeKey(toRoute(target)));
  }

  /**
   * Get or create a session for a route (chat + optional topic thread).
   * Concurrent calls share a single in-flight creation promise — two Telegram
   * messages arriving within milliseconds must not spawn duplicate sessions.
   */
  async getSession(target: RouteTarget): Promise<IAgentSession> {
    const route = toRoute(target);
    const key = routeKey(route);

    const existing = this.sessions.get(key);
    if (existing) {
      this._touchActivity(key);
      return existing;
    }

    // If there is already an in-flight creation for this route, wait for it.
    // Use try/finally so _touchActivity runs on both success and rejection —
    // invariant: callers must not observe a stale lastActivity on retry after a failure.
    const inflight = this.pendingSessions.get(key);
    if (inflight) {
      try {
        const session = await inflight;
        return session;
      } finally {
        this._touchActivity(key);
      }
    }

    // No session and no pending creation — start one. New SessionData carries
    // the chatId (provenance/sends) and the topic threadId (route round-trip).
    const data = this.sessionData.get(key) ?? this._newData(route);

    const creationPromise = (async (): Promise<IAgentSession> => {
      const config: AgentConfig = {
        model: data.model,
        apiKey: this.options.apiKey,
        telegramChatId: route.chatId,
        ...(route.threadId !== undefined ? { telegramThreadId: route.threadId } : {}),
      };
      if (this.options.settingSources?.length) {
        config.settingSources = this.options.settingSources;
      }
      if (this.options.thinking !== undefined) {
        config.thinking = this.options.thinking;
      }
      if (this.options.effort !== undefined) {
        config.effort = this.options.effort;
      }
      // Per-session cwd (set via /cd) overrides the bot-global botCwd.
      // When neither is set, leave config.cwd undefined and let the
      // downstream createSession factory fall back to its own default.
      const effectiveCwd = data.cwd ?? this.options.botCwd;
      if (effectiveCwd !== undefined && effectiveCwd.length > 0) {
        config.cwd = effectiveCwd;
      }
      // /switch: continue a staged prior conversation instead of starting fresh.
      // Consumed after a successful build below — a failed createSession leaves it
      // staged so the next getSession retries the resume; teardown via _resetStats
      // (/clear, model switch, /cd) still clears any stale target.
      // Load the target sidecar and populate the SAME resume fields the CLI does
      // (resume + sessionId + resumeHistory) so the providers actually replay the
      // saved transcript. Forwarding only config.resume (the SDK id) resumes an
      // empty conversation. Mirrors resumeConfigFor (src/cli/resume-session.ts).
      const resumeTarget = this.pendingResume.get(key);
      if (resumeTarget !== undefined) {
        const stored = loadSession(resumeTarget);
        Object.assign(
          config,
          resumeConfigFor({
            id: resumeTarget,
            resumeId: stored?.sessionId ?? resumeTarget,
            stored,
          }),
        );
      }

      const session = await this.options.createSession(injectCompanionPrimer(injectHotMemory(config)));
      this.sessions.set(key, session);
      this.sessionData.set(key, data);
      // Register with the session registry (best-effort: never orphan the live session).
      try { this._ensureRegistryHandle(route, data); } catch { /* non-fatal */ }
      // Seed elicitation routing before the first turn starts. ask_question can
      // suspend that turn, so waiting for recordTelegramTurn (onComplete) would
      // deadlock a topic's first question on the General-route fallback.
      if (session.sessionId) {
        setElicitationRoute(session.sessionId, route);
        data.sessionId = session.sessionId;
      }
      // Wave-manifest reconciliation: surface resumption offers for unfinished
      // work. Telegram is interactive — fire-and-forget, never blocks creation.
      if (this.options.onResumptionOffer) {
        runTelegramReconcile(session.sessionId ?? '', route, this.options.onResumptionOffer);
      }
      // Consume the staged resume only after a successful build: a thrown
      // createSession must leave it staged so the next getSession retries the
      // resume instead of silently starting a fresh conversation.
      if (resumeTarget !== undefined) this.pendingResume.delete(key);
      return session;
    })();

    this.pendingSessions.set(key, creationPromise);
    try {
      const session = await creationPromise;
      this._touchActivity(key);
      return session;
    } finally {
      // Always clean up the in-flight entry regardless of success or failure.
      this.pendingSessions.delete(key);
    }
  }

  /** Build a fresh SessionData for a route, carrying chatId + topic threadId. */
  private _newData(route: TelegramRoute): SessionData {
    const data: SessionData = {
      chatId: route.chatId,
      model: this.options.defaultModel,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
    if (route.threadId !== undefined) data.threadId = route.threadId;
    return data;
  }

  private _touchActivity(key: string): void {
    const data = this.sessionData.get(key);
    if (data) data.lastActivity = new Date().toISOString();
  }

  /** Delegate to the extracted registry-wiring module. Resolves the registry ref once. */
  private _ensureRegistryHandle(route: TelegramRoute, data: SessionData): void {
    ensureRegistryHandle(this.options.registry ?? sessionRegistry, route, data, this.options.defaultModel);
  }

  /** Record a completed turn. Reuses CLI's recordTurn + saveSession. Best-effort. */
  recordTelegramTurn(
    target: RouteTarget,
    userText: string,
    assistantText: string,
    metadata?: ResponseMetadata,
  ): void {
    const route = toRoute(target);
    const key = routeKey(route);
    const stats = this._getOrCreateStats(route);

    // Capture the SDK sessionId from the live session if the turn metadata
    // didn't carry one (recordTurn also sets it from metadata when present).
    const live = this.sessions.get(key);
    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    recordTurn(stats, userText, assistantText, metadata);

    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    // Mirror the captured sessionId into SessionData so it survives bot restart.
    const data = this.sessionData.get(key);
    if (data && stats.sessionId) data.sessionId = stats.sessionId;

    // Register the sessionId → route mapping so the elicitation handler can
    // route ask_question prompts to the correct topic thread. Idempotent — safe
    // to call on every turn even when the mapping already exists.
    if (stats.sessionId) setElicitationRoute(stats.sessionId, route);

    // Persist to the shared store. Requires a sessionId to key the file;
    // without one (rare provider that emits none) the turn stays in memory and
    // is flushed once a sessionId appears on a later turn.
    if (stats.sessionId) {
      try {
        saveSession(stats);
      } catch (err) {
        // Best-effort — never break the chat on a persistence failure. Surface
        // the FIRST failure per route (autosaveFailureLogged) so a persistent
        // EACCES/ENOSPC isn't silently swallowed every turn while the user
        // assumes the conversation is resumable from `afk i --resume`.
        if (!this.autosaveFailureLogged.has(key)) {
          this.autosaveFailureLogged.add(key);
          console.error(
            `[session-manager] autosave failed for chat ${route.chatId} — conversation may not be resumable:`,
            err,
          );
        }
      }
    }
  }

  /**
   * Hydrate in-memory stats from the persisted sidecar for a chat whose
   * sessionId survived a bot restart in sessionData but whose sessionStats
   * entry was lost (sessionStats is in-memory-only and starts empty on restart).
   *
   * Guards:
   * - No-op when stats already exist in memory (never clobber live state).
   * - No-op when sessionData carries no sessionId (nothing to hydrate from).
   * - No-op when the sidecar cannot be loaded (missing / corrupted file).
   * - No-op when the sidecar is not a telegram sidecar for THIS chat (source
   *   guard prevents accidentally adopting a CLI sidecar that happens to share
   *   a sessionId).
   *
   * After hydration, setSessionName and recordTelegramTurn both see the full
   * prior-conversation stats (sessionId, turns, totals), so a rename persists
   * in-place without forking a duplicate sidecar and turn counts are preserved.
   */
  private _hydrateStatsFromStore(route: TelegramRoute): void {
    const key = routeKey(route);
    // Never clobber live in-memory stats — this is a post-restart-only repair.
    if (this.sessionStats.has(key)) return;

    const sessionId = this.sessionData.get(key)?.sessionId;
    if (!sessionId) return;

    const stored = loadSession(sessionId);
    if (!stored) return;

    // Only hydrate telegram sidecars that belong to THIS chat — prevent
    // accidentally adopting a CLI sidecar or a different chat's sidecar. The
    // per-route sidecar is keyed by SDK sessionId, so a topic can only hydrate
    // its own conversation (each topic's session has a distinct sessionId).
    if (stored.source !== 'telegram' || stored.telegramChatId !== route.chatId) return;

    // Map StoredSession → SessionStats.
    // Critical rename: stored.startedAt === SessionStats.sessionStartTime.
    // Fields not persisted (turnCosts, turnTokens, permissionMode) are
    // reconstructed as empty/default — they are runtime-only display helpers,
    // not resumption data. The round-trip contract is: saveSession(hydrated) === the original
    // sidecar (modulo savedAt timestamp), so a post-hydration persist does NOT
    // fork a new file.
    const stats: SessionStats = {
      sessionId: stored.sessionId,
      name: stored.name,
      model: stored.model,
      source: stored.source,
      telegramChatId: stored.telegramChatId,
      sessionStartTime: stored.startedAt,
      totalTurns: stored.totalTurns,
      totalCostUsd: stored.totalCostUsd,
      unpricedTurns: stored.unpricedTurns ?? 0,
      totalTokens: stored.totalTokens,
      totalDurationMs: stored.totalDurationMs,
      turns: stored.turns,
      // Runtime-only fields — reconstructed as empty defaults.
      turnCosts: [],
      turnTokens: [],
      permissionMode: 'default',
    };
    // Carry forward the per-route cwd override if one was set via /cd.
    const chatCwd = this.sessionData.get(key)?.cwd;
    if (chatCwd !== undefined) stats.cwd = chatCwd;
    this.sessionStats.set(key, stats);
  }

  /**
   * Get the current human-readable name for a chat's session, if one exists.
   *
   * Reads from the accumulating per-chat stats — returns the name set via
   * `/name` or auto-derived from the first user message by `recordTurn`, or
   * undefined when no name has been established yet (e.g. before the first
   * turn and before any explicit `/name`).
   *
   * After a bot restart, hydrates stats from the persisted sidecar (via
   * _hydrateStatsFromStore) so an already-named conversation reports its name
   * correctly instead of returning undefined. Does NOT route through
   * _getOrCreateStats — that would fabricate an empty stats entry for a
   * genuinely new chat that has never had a session.
   */
  getSessionName(target: RouteTarget): string | undefined {
    const route = toRoute(target);
    this._hydrateStatsFromStore(route);
    return this.sessionStats.get(routeKey(route))?.name;
  }

  /**
   * Set the human-readable name for a chat's session. Persists to the shared
   * store immediately when a sessionId exists, otherwise deferred to next turn.
   * @returns `{ persisted }` — true when written to disk now, false when deferred.
   */
  setSessionName(target: RouteTarget, slug: string): { persisted: boolean } {
    const route = toRoute(target);
    const key = routeKey(route);
    const stats = this._getOrCreateStats(route);
    stats.name = slug;

    // Capture the live session's id if the stats don't carry one yet, so the
    // persisted sidecar is keyed the same way the per-turn autosave keys it.
    const live = this.sessions.get(key);
    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    if (stats.totalTurns > 0 && stats.sessionId) {
      // Mirror the captured sessionId into SessionData BEFORE saveSession so
      // the data.sessionId update is guaranteed even if saveSession throws.
      // The throw still propagates to the caller so it can report the failure.
      const data = this.sessionData.get(key);
      if (data) data.sessionId = stats.sessionId;
      saveSession(stats);
      return { persisted: true };
    }
    return { persisted: false };
  }

  /**
   * Get (or lazily create) the accumulating stats for a chat. New stats are
   * tagged with the chat's current model, cwd, and Telegram origin so the
   * stored sidecar is identifiable as a chat session.
   *
   * After a bot restart, hydrates stats from the persisted sidecar first
   * (via _hydrateStatsFromStore) so setSessionName and recordTelegramTurn
   * see the full prior-conversation state instead of fresh empty stats.
   */
  private _getOrCreateStats(route: TelegramRoute): SessionStats {
    const key = routeKey(route);
    // Repair post-restart: if sessionData has a sessionId but sessionStats is
    // empty, hydrate from the persisted sidecar before the get-or-create.
    this._hydrateStatsFromStore(route);

    let stats = this.sessionStats.get(key);
    if (!stats) {
      stats = createSessionStats(this.getModel(route));
      stats.source = 'telegram';
      // Provenance stays the chatId (topics in one chat share it); the route's
      // isolation lives in the routeKey the maps + sidecar filename key on.
      stats.telegramChatId = route.chatId;
      const cwd = this.getCwd(route);
      if (cwd) stats.cwd = cwd;
      this.sessionStats.set(key, stats);
    }
    return stats;
  }

  /**
   * Drop the accumulating stats and stale sessionId for a route. Called when
   * the underlying AgentSession is torn down (/clear, model switch, /cd) so
   * the rebuilt session captures a fresh sessionId and auto-name rather than
   * appending to the previous conversation's sidecar.
   */
  private _resetStats(key: string): void {
    // Clear the elicitation route mapping for the session being torn down, so
    // a future session that reuses the same SDK sessionId cannot accidentally
    // route prompts to this route. Clear before deleting the stats entry, while
    // the sessionId is still accessible.
    const sessionId = this.sessionStats.get(key)?.sessionId
      ?? this.sessionData.get(key)?.sessionId;
    if (sessionId) clearElicitationRoute(sessionId);

    this.sessionStats.delete(key);
    // Fresh conversation → allow the autosave-failure notice to fire again.
    this.autosaveFailureLogged.delete(key);
    // Drop any staged /switch resume so a teardown always starts fresh.
    this.pendingResume.delete(key);
    const data = this.sessionData.get(key);
    if (data) delete data.sessionId;
  }

  /**
   * Reset a route's session (clear history).
   *
   * @param target - Route (chat + optional topic) or a bare chatId (General topic)
   */
  async resetSession(target: RouteTarget): Promise<void> {
    const route = toRoute(target);
    const key = routeKey(route);
    // Archive the registry handle FIRST so the stale handle is freed before
    // _resetStats clears the sessionId. Best-effort: non-fatal if never registered.
    try { archiveRegistryHandle(this.options.registry ?? sessionRegistry, key); } catch { /* best-effort */ }
    const oldSession = this.sessions.get(key);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(key);
    }
    // New conversation → drop accumulated stats + stale sessionId so the
    // rebuilt session is recorded as a fresh sidecar, not appended to the old.
    this._resetStats(key);

    // Keep session data but create new session on next request
    const data = this.sessionData.get(key);
    if (data) data.lastActivity = new Date().toISOString();
  }

  /**
   * Switch model for a route's session.
   *
   * @param target - Route (chat + optional topic) or a bare chatId (General topic)
   * @param model - New model to use
   */
  async switchModel(target: RouteTarget, model: AgentModelInput): Promise<void> {
    const route = toRoute(target);
    const key = routeKey(route);
    // Archive the stale registry handle before teardown (same rationale as resetSession).
    try { archiveRegistryHandle(this.options.registry ?? sessionRegistry, key); } catch { /* best-effort */ }
    // Close old session
    const oldSession = this.sessions.get(key);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(key);
    }
    // Model switch rebuilds the session with a new sessionId → fresh sidecar.
    this._resetStats(key);

    // Update session data
    let data = this.sessionData.get(key);
    if (!data) {
      data = this._newData(route);
      data.model = model;
      this.sessionData.set(key, data);
    } else {
      data.model = model;
      data.lastActivity = new Date().toISOString();
    }

    // Pre-register with the updated model (best-effort, non-fatal).
    try { this._ensureRegistryHandle(route, data); } catch { /* non-fatal */ }
    // New session will be created on next message
  }

  /**
   * Get current model for a route.
   *
   * @param target - Route (chat + optional topic) or a bare chatId (General topic)
   * @returns Current model
   */
  getModel(target: RouteTarget): AgentModelInput {
    const data = this.sessionData.get(routeKey(toRoute(target)));
    return data?.model || this.options.defaultModel;
  }

  /**
   * Set the working directory for a chat session.
   *
   * Closes any existing session for this chat so the next message creates
   * a fresh session in the new cwd. The persisted `data.cwd` survives
   * bot restart. Mirrors the `switchModel` close-and-recreate pattern.
   *
   * Callers are responsible for validating that `cwd` exists and is a
   * directory before calling — this method does not stat the filesystem.
   *
   * @param target - Route (chat + optional topic) or a bare chatId (General topic)
   * @param cwd - Absolute path to the new working directory
   */
  async setCwd(target: RouteTarget, cwd: string): Promise<void> {
    const route = toRoute(target);
    const key = routeKey(route);
    // Close old session — next getSession() call rebuilds it with the
    // new cwd threaded through to the AgentSession + SubagentManager.
    const oldSession = this.sessions.get(key);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(key);
    }
    // cwd change rebuilds the session with a new sessionId → fresh sidecar.
    this._resetStats(key);

    let data = this.sessionData.get(key);
    if (!data) {
      data = this._newData(route);
      data.cwd = cwd;
      this.sessionData.set(key, data);
    } else {
      data.cwd = cwd;
      data.lastActivity = new Date().toISOString();
    }
  }

  /**
   * Get the effective working directory for a route: per-session override
   * (set via `/cd`) if present, otherwise the bot-global fallback.
   *
   * Returns undefined when neither is set — callers that need a real
   * path should fall back to `process.cwd()`.
   *
   * @param target - Route (chat + optional topic) or a bare chatId (General topic)
   * @returns Effective cwd, or undefined when no override is configured
   */
  getCwd(target: RouteTarget): string | undefined {
    const data = this.sessionData.get(routeKey(toRoute(target)));
    return data?.cwd ?? this.options.botCwd;
  }

  /**
   * List this chat's resumable conversations for the `/sessions` switcher,
   * newest-active first. Sourced from the shared sidecar store (telegram
   * sidecars for this chatId) — the durable record of every conversation the
   * chat has held — with the route's currently-active one flagged.
   *
   * Provenance is the chatId, so this lists every conversation the chat has
   * held (across General and any topics). The `active` flag reflects the
   * requesting route's own live session id — the conversation the switcher
   * would replace on that route.
   *
   * A brand-new conversation with no recorded turn yet has no sidecar and so
   * does not appear until its first turn is saved.
   */
  listChatSessions(target: RouteTarget): ChatSessionInfo[] {
    const route = toRoute(target);
    const activeId = this.sessionData.get(routeKey(route))?.sessionId;
    return listSessions()
      .filter(
        (s) => s.source === 'telegram' && s.telegramChatId === route.chatId && s.sessionId !== undefined,
      )
      .map((s) => {
        const info: ChatSessionInfo = {
          sessionId: s.sessionId as string,
          model: s.model,
          turns: s.totalTurns,
          lastActive: s.savedAt,
          active: s.sessionId === activeId,
        };
        if (s.name !== undefined) info.name = s.name;
        return info;
      })
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /**
   * Switch the chat's active conversation to a previously-persisted session
   * (the `/switch` command). Closes the current live session — its sidecar is
   * already persisted per-turn, so it stays resumable — drops in-memory stats so
   * the target's name/turns re-hydrate from its sidecar, adopts the target's
   * model + cwd, and stages the SDK session id for resume. The next
   * getSession(chatId) rebuilds the session with `config.resume` so it continues
   * the chosen conversation; callers wanting it warmed can await getSession after.
   *
   * @returns `{ ok: true }` on success; `{ ok: false, reason }` when the target
   *   is missing / not a telegram sidecar for this chat, or already active.
   */
  async switchToSession(
    target: RouteTarget,
    targetSessionId: string,
  ): Promise<{ ok: true; name?: string } | { ok: false; reason: 'not-found' | 'already-active' }> {
    const route = toRoute(target);
    const key = routeKey(route);

    // If a session creation is in flight for this route, let it settle before we
    // inspect and close the live session. Otherwise the in-flight promise sets
    // the pre-switch session as live AFTER we adopt the target below, silently
    // reverting the switch. Awaiting materializes it so the close path evicts it
    // normally; a failed creation leaves this.sessions empty, which the `old`
    // guard already handles.
    const inflight = this.pendingSessions.get(key);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }

    // Already the live active conversation → no-op (avoid a needless rebuild).
    if (this.sessions.has(key) && this.sessionData.get(key)?.sessionId === targetSessionId) {
      return { ok: false, reason: 'already-active' };
    }

    const stored = loadSession(targetSessionId);
    if (!stored || stored.source !== 'telegram' || stored.telegramChatId !== route.chatId) {
      return { ok: false, reason: 'not-found' };
    }

    // Close the current live session (sidecar already persisted per-turn).
    const old = this.sessions.get(key);
    if (old) {
      // Guard the close (mirrors closeAll): a throwing close() must never block
      // the delete + target-state adoption below, or the stale session stays keyed
      // in this.sessions and the next getSession returns it unrebuilt.
      await old.close().catch((err) => console.error('Error closing session on switch:', err));
      this.sessions.delete(key);
    }
    // Drop in-memory stats so the resumed session hydrates the TARGET's stats
    // (name/turns/sessionId) from its sidecar on next access — never the
    // previous conversation's. autosave-failure notice re-arms for the switch.
    this.sessionStats.delete(key);
    this.autosaveFailureLogged.delete(key);

    // Adopt the target's identity + model/cwd and stage the resume.
    let data = this.sessionData.get(key);
    if (!data) {
      data = this._newData(route);
      data.model = stored.model;
      this.sessionData.set(key, data);
    } else {
      data.model = stored.model;
      data.lastActivity = new Date().toISOString();
    }
    data.sessionId = targetSessionId;
    // Adopt the target's cwd, or CLEAR a stale per-chat override when the target
    // has none — otherwise the resumed session runs + autosaves under the
    // previously-active conversation's directory (getSession uses data.cwd ?? botCwd).
    if (stored.cwd !== undefined) data.cwd = stored.cwd;
    else delete data.cwd;
    this.pendingResume.set(key, targetSessionId);
    return stored.name !== undefined ? { ok: true, name: stored.name } : { ok: true };
  }

  /**
   * Start a fresh conversation for the chat (the `/new` command), preserving the
   * previous one as a resumable session — its sidecar was persisted per-turn and
   * is never deleted here, so `/sessions` still lists it and `/switch` can return
   * to it. Behaviorally this is resetSession (close + fresh sessionId), exposed
   * under a name that reflects the switcher intent.
   */
  async newSession(target: RouteTarget): Promise<void> {
    // resetSession → _resetStats already clears pendingResume; explicit here too
    // so intent is local and obvious.
    this.pendingResume.delete(routeKey(toRoute(target)));
    await this.resetSession(target);
  }

  /**
   * The on-disk sidecar filename for a route's SessionData.
   *
   * Invariant: a General route's file is `<chatId>.json` — byte-identical to
   * the pre-topics layout, so an existing user's session data loads unchanged.
   * A topic route uses its routeKey (`<chatId>:<threadId>`). The `:` separator
   * is legal on the macOS/Linux targets AFK supports; the loader recomputes the
   * map key from the data's chatId+threadId, so it never relies on the filename.
   */
  private sidecarFileName(data: SessionData): string {
    const route: TelegramRoute = { chatId: data.chatId };
    if (data.threadId !== undefined) route.threadId = data.threadId;
    return `${routeKey(route)}.json`;
  }

  /**
   * Load session data from disk.
   *
   * Keys the in-memory map by the route recomputed from each file's payload
   * (chatId + optional threadId), NOT the filename — so a legacy `<chatId>.json`
   * (no threadId) loads to the General key `String(chatId)` exactly as before,
   * and a topic sidecar loads to `<chatId>:<threadId>`.
   */
  async loadSessions(): Promise<void> {
    try {
      await fs.mkdir(this.options.dataDir, { recursive: true });
      const files = await fs.readdir(this.options.dataDir);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = join(this.options.dataDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const data: SessionData = JSON.parse(content);
          const route: TelegramRoute = { chatId: data.chatId };
          if (data.threadId !== undefined) route.threadId = data.threadId;
          this.sessionData.set(routeKey(route), data);
          try {
            this._ensureRegistryHandle(route, data);
          } catch {
            // non-fatal: registry error should not skip remaining sidecars
          }
        }
      }
    } catch (error) {
      // Ignore errors if directory doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to load sessions:', error);
      }
    }
  }

  /**
   * Save session data to disk, one file per route (General → `<chatId>.json`).
   */
  async saveSessions(): Promise<void> {
    try {
      await fs.mkdir(this.options.dataDir, { recursive: true });
      
      for (const data of this.sessionData.values()) {
        const filePath = join(this.options.dataDir, this.sidecarFileName(data));
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      }
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  /**
   * Evict sessionData entries that have had no activity for longer than
   * `maxAgeMs` (default 24 hours). Called from closeAll so stale entries
   * accumulated over a long bot uptime are pruned on each orderly shutdown
   * without being so aggressive that UX-continuity state (model, cwd, name)
   * is lost mid-conversation.
   *
   * Invariant: only entries whose route has NO live session are eligible — a
   * session in `this.sessions` is by definition still active, so its data is
   * always retained regardless of lastActivity.
   */
  private _evictStaleSessionData(maxAgeMs = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, data] of this.sessionData) {
      if (this.sessions.has(key)) continue; // live session — never evict
      const age = now - new Date(data.lastActivity).getTime();
      if (age > maxAgeMs) this.sessionData.delete(key);
    }
  }

  /**
   * Close all sessions and clean up
   */
  async closeAll(): Promise<void> {
    this._evictStaleSessionData();
    await this.saveSessions();
    await Promise.all(Array.from(this.sessions.values()).map(
      session => session.close().catch(err => console.error('Error closing session:', err))
    ));
    this.sessions.clear();
  }

  /** Get total number of active sessions */
  getSessionCount(): number { return this.sessions.size; }

  /** Get total number of tracked chats */
  getChatCount(): number { return this.sessionData.size; }

  /**
   * Return the most recently active topic thread id for a given chat, or
   * `undefined` when the chat has no topic sessions (non-topic chat, or all
   * sessions belong to General).
   *
   * Used by the auto-subscribe loop to route watch output to the correct topic
   * thread without an inbound message context. The lookup scans `sessionData`
   * (in-memory, populated from disk on start) for all entries that share
   * `chatId` and carry a `threadId`, then picks the entry with the most-recent
   * `lastActivity` timestamp.
   *
   * Backward-compatible: returns `undefined` for any chat that has never used
   * Telegram topics, leaving the downstream `sendOptions` call equivalent to
   * the pre-fix General-only behaviour.
   *
   * @param chatId - Telegram chat id to look up
   * @returns The most recently active topic thread id for this chat, or `undefined`
   */
  getActiveThreadId(chatId: number): number | undefined {
    let best: SessionData | undefined;
    for (const data of this.sessionData.values()) {
      if (data.chatId !== chatId || data.threadId === undefined) continue;
      if (best === undefined || data.lastActivity > best.lastActivity) {
        best = data;
      }
    }
    return best?.threadId;
  }

  /**
   * Count sessions that are mid-turn (not idle and not closed).
   *
   * Used by the version-drift watchdog to defer the upgrade-exit while a
   * conversation is in flight. A session in 'processing' / 'streaming' /
   * 'compacting' is actively producing output (or rewriting history); exiting
   * the process under it kills the turn, its queued messages, and any
   * sub-agent dispatch — none of which the relaunched binary can resume.
   *
   * Fail-safe: any non-idle, non-closed state counts as busy, so a future
   * SessionState variant defaults to "defer the exit" rather than "kill it".
   */
  getBusySessionCount(): number {
    let busy = 0;
    for (const session of this.sessions.values()) {
      if (session.state !== 'idle' && session.state !== 'closed') busy++;
    }
    return busy;
  }

  /**
   * Return the most recently active route for a given chatId, or `undefined`
   * when no session data exists for that chat. Delegates to the extracted
   * `resolveActiveRouteForChat` helper (session-manager.active-route.ts).
   */
  getActiveRouteForChat(chatId: number): TelegramRoute | undefined { return resolveActiveRouteForChat(this.sessionData.values(), chatId); }
}
