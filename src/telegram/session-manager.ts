/**
 * Telegram chat session management
 * @module telegram/session-manager
 */

import type { IAgentSession, AgentConfig, AgentModelInput, ThinkingConfig, EffortLevel, ResponseMetadata } from '../agent/types.js';
import { injectHotMemory } from '../agent/memory/index.js';
import { injectCompanionPrimer } from '../agent/companion/index.js';
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
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Session data for persistence
 */
interface SessionData {
  chatId: number;
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

  /** API key for the active provider (Anthropic or OpenAI Codex). May be empty when using OAuth state. */
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
}

/**
 * Manages Telegram chat sessions
 * One AgentSession per chat ID
 */
export class SessionManager {
  private sessions = new Map<number, IAgentSession>();
  /** In-flight creation promises — prevent duplicate session spawns on concurrent messages. */
  private pendingSessions = new Map<number, Promise<IAgentSession>>();
  private sessionData = new Map<number, SessionData>();
  /**
   * Per-chat accumulating session stats (turns, totals, name, sessionId).
   * Recorded on each completed turn and written to the shared session store
   * so the CLI can `--resume <name>` a Telegram conversation. Reset whenever
   * the underlying AgentSession is torn down (/clear, model switch, /cd) so a
   * fresh sessionId and name are captured for the rebuilt session.
   */
  private sessionStats = new Map<number, SessionStats>();
  /**
   * Chats that have already logged an autosave failure this conversation.
   * Per-turn autosave is best-effort, but a persistent failure (EACCES,
   * ENOSPC) would otherwise be silently swallowed every turn while the user
   * assumes the chat is resumable from the CLI. Log the FIRST failure per chat
   * and stay quiet afterwards; the entry is cleared on _resetStats so a fresh
   * conversation gets a fresh warning.
   */
  private autosaveFailureLogged = new Set<number>();
  /**
   * Chats with a staged `/switch` resume target (SDK session id). Consumed once
   * by the next getSession() to build the rebuilt session with `config.resume`
   * so it continues the chosen prior conversation. Cleared on any teardown
   * (/clear, model switch, /cd) via _resetStats so those start fresh, never
   * resuming a stale target.
   */
  private pendingResume = new Map<number, string>();
  private options: Required<Omit<SessionManagerOptions, 'createSession' | 'settingSources' | 'thinking' | 'effort' | 'botCwd'>> &
    Pick<SessionManagerOptions, 'createSession' | 'settingSources' | 'thinking' | 'effort' | 'botCwd'>;

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
    };
  }

  /**
   * Get existing session for a chat without creating one.
   * Used e.g. to read SDK-native slash commands for /help.
   */
  getSessionIfExists(chatId: number): IAgentSession | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Get or create a session for a chat.
   *
   * Concurrent calls for the same `chatId` that arrive before the first
   * session is fully initialised (e.g. two Telegram messages arriving within
   * milliseconds of each other) all share a single in-flight creation promise
   * rather than spawning duplicate sessions.
   *
   * @param chatId - Telegram chat ID
   * @returns Agent session
   */
  async getSession(chatId: number): Promise<IAgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      this._touchActivity(chatId);
      return existing;
    }

    // If there is already an in-flight creation for this chatId, wait for it.
    // Use try/finally so _touchActivity runs on both success and rejection —
    // invariant: callers must not observe a stale lastActivity on retry after a failure.
    const inflight = this.pendingSessions.get(chatId);
    if (inflight) {
      try {
        const session = await inflight;
        return session;
      } finally {
        this._touchActivity(chatId);
      }
    }

    // No session and no pending creation — start one.
    const data = this.sessionData.get(chatId) ?? {
      chatId,
      model: this.options.defaultModel,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };

    const creationPromise = (async (): Promise<IAgentSession> => {
      const config: AgentConfig = {
        model: data.model,
        apiKey: this.options.apiKey,
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
      const resumeTarget = this.pendingResume.get(chatId);
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
      this.sessions.set(chatId, session);
      this.sessionData.set(chatId, data);
      // Consume the staged resume only after a successful build: a thrown
      // createSession must leave it staged so the next getSession retries the
      // resume instead of silently starting a fresh conversation.
      if (resumeTarget !== undefined) this.pendingResume.delete(chatId);
      return session;
    })();

    this.pendingSessions.set(chatId, creationPromise);
    try {
      const session = await creationPromise;
      this._touchActivity(chatId);
      return session;
    } finally {
      // Always clean up the in-flight entry regardless of success or failure.
      this.pendingSessions.delete(chatId);
    }
  }

  private _touchActivity(chatId: number): void {
    const data = this.sessionData.get(chatId);
    if (data) data.lastActivity = new Date().toISOString();
  }

  /**
   * Record a completed turn into the shared session store so the CLI can
   * resume this Telegram conversation by name (`afk i --resume <name>`).
   *
   * Reuses the CLI's `recordTurn` (auto-names from the first user message,
   * captures the SDK sessionId from metadata, builds the TurnRecord) and
   * `saveSession` (writes ~/.afk/state/sessions/<sessionId>.json, keyed by
   * sessionId — never the name, so no duplicate sidecars). Best-effort:
   * persistence failures never disrupt the chat.
   */
  recordTelegramTurn(
    chatId: number,
    userText: string,
    assistantText: string,
    metadata?: ResponseMetadata,
  ): void {
    const stats = this._getOrCreateStats(chatId);

    // Capture the SDK sessionId from the live session if the turn metadata
    // didn't carry one (recordTurn also sets it from metadata when present).
    const live = this.sessions.get(chatId);
    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    recordTurn(stats, userText, assistantText, metadata);

    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    // Mirror the captured sessionId into SessionData so it survives bot restart.
    const data = this.sessionData.get(chatId);
    if (data && stats.sessionId) data.sessionId = stats.sessionId;

    // Persist to the shared store. Requires a sessionId to key the file;
    // without one (rare provider that emits none) the turn stays in memory and
    // is flushed once a sessionId appears on a later turn.
    if (stats.sessionId) {
      try {
        saveSession(stats);
      } catch (err) {
        // Best-effort — never break the chat on a persistence failure. Surface
        // the FIRST failure per chat (autosaveFailureLogged) so a persistent
        // EACCES/ENOSPC isn't silently swallowed every turn while the user
        // assumes the conversation is resumable from `afk i --resume`.
        if (!this.autosaveFailureLogged.has(chatId)) {
          this.autosaveFailureLogged.add(chatId);
          console.error(
            `[session-manager] autosave failed for chat ${chatId} — conversation may not be resumable:`,
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
  private _hydrateStatsFromStore(chatId: number): void {
    // Never clobber live in-memory stats — this is a post-restart-only repair.
    if (this.sessionStats.has(chatId)) return;

    const sessionId = this.sessionData.get(chatId)?.sessionId;
    if (!sessionId) return;

    const stored = loadSession(sessionId);
    if (!stored) return;

    // Only hydrate telegram sidecars that belong to THIS chat — prevent
    // accidentally adopting a CLI sidecar or a different chat's sidecar.
    if (stored.source !== 'telegram' || stored.telegramChatId !== chatId) return;

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
      totalTokens: stored.totalTokens,
      totalDurationMs: stored.totalDurationMs,
      turns: stored.turns,
      // Runtime-only fields — reconstructed as empty defaults.
      turnCosts: [],
      turnTokens: [],
      permissionMode: 'default',
    };
    // Carry forward the per-chat cwd override if one was set via /cd.
    const chatCwd = this.sessionData.get(chatId)?.cwd;
    if (chatCwd !== undefined) stats.cwd = chatCwd;
    this.sessionStats.set(chatId, stats);
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
  getSessionName(chatId: number): string | undefined {
    this._hydrateStatsFromStore(chatId);
    return this.sessionStats.get(chatId)?.name;
  }

  /**
   * Set the human-readable name for a chat's session, mirroring the CLI
   * `/name` command. The caller passes an already-slugified name (the handler
   * slugifies so it can reject invalid input before reaching here).
   *
   * Sets `stats.name` on the accumulating per-chat stats (creating the entry
   * if needed). When the conversation already has a recorded turn AND a
   * captured sessionId, persists immediately to the shared session store so
   * `afk i --resume <name>` resolves it by name. Otherwise the name is held in
   * memory and rides along on the first per-turn autosave — saveSession keys on
   * sessionId, so persisting without one would fork a timestamp-id sidecar the
   * autosave never updates.
   *
   * @returns `{ persisted }` — true when written to disk now, false when only
   *   set in memory (no turn yet) and deferred to the next per-turn autosave.
   * @throws Propagates a `saveSession` failure so the caller can report that
   *   the name was set but the immediate persist failed (retries on next turn).
   */
  setSessionName(chatId: number, slug: string): { persisted: boolean } {
    const stats = this._getOrCreateStats(chatId);
    stats.name = slug;

    // Capture the live session's id if the stats don't carry one yet, so the
    // persisted sidecar is keyed the same way the per-turn autosave keys it.
    const live = this.sessions.get(chatId);
    if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

    if (stats.totalTurns > 0 && stats.sessionId) {
      // Mirror the captured sessionId into SessionData BEFORE saveSession so
      // the data.sessionId update is guaranteed even if saveSession throws.
      // The throw still propagates to the caller so it can report the failure.
      const data = this.sessionData.get(chatId);
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
  private _getOrCreateStats(chatId: number): SessionStats {
    // Repair post-restart: if sessionData has a sessionId but sessionStats is
    // empty, hydrate from the persisted sidecar before the get-or-create.
    this._hydrateStatsFromStore(chatId);

    let stats = this.sessionStats.get(chatId);
    if (!stats) {
      stats = createSessionStats(this.getModel(chatId));
      stats.source = 'telegram';
      stats.telegramChatId = chatId;
      const cwd = this.getCwd(chatId);
      if (cwd) stats.cwd = cwd;
      this.sessionStats.set(chatId, stats);
    }
    return stats;
  }

  /**
   * Drop the accumulating stats and stale sessionId for a chat. Called when
   * the underlying AgentSession is torn down (/clear, model switch, /cd) so
   * the rebuilt session captures a fresh sessionId and auto-name rather than
   * appending to the previous conversation's sidecar.
   */
  private _resetStats(chatId: number): void {
    this.sessionStats.delete(chatId);
    // Fresh conversation → allow the autosave-failure notice to fire again.
    this.autosaveFailureLogged.delete(chatId);
    // Drop any staged /switch resume so a teardown always starts fresh.
    this.pendingResume.delete(chatId);
    const data = this.sessionData.get(chatId);
    if (data) delete data.sessionId;
  }

  /**
   * Reset a chat session (clear history)
   * 
   * @param chatId - Telegram chat ID
   */
  async resetSession(chatId: number): Promise<void> {
    const oldSession = this.sessions.get(chatId);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(chatId);
    }
    // New conversation → drop accumulated stats + stale sessionId so the
    // rebuilt session is recorded as a fresh sidecar, not appended to the old.
    this._resetStats(chatId);

    // Keep session data but create new session on next request
    const data = this.sessionData.get(chatId);
    if (data) {
      data.lastActivity = new Date().toISOString();
    }
  }

  /**
   * Switch model for a chat session
   * 
   * @param chatId - Telegram chat ID
   * @param model - New model to use
   */
  async switchModel(chatId: number, model: AgentModelInput): Promise<void> {
    // Close old session
    const oldSession = this.sessions.get(chatId);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(chatId);
    }
    // Model switch rebuilds the session with a new sessionId → fresh sidecar.
    this._resetStats(chatId);

    // Update session data
    let data = this.sessionData.get(chatId);
    if (!data) {
      data = {
        chatId,
        model,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
      this.sessionData.set(chatId, data);
    } else {
      data.model = model;
      data.lastActivity = new Date().toISOString();
    }
    
    // New session will be created on next message
  }

  /**
   * Get current model for a chat
   * 
   * @param chatId - Telegram chat ID
   * @returns Current model
   */
  getModel(chatId: number): AgentModelInput {
    const data = this.sessionData.get(chatId);
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
   * @param chatId - Telegram chat ID
   * @param cwd - Absolute path to the new working directory
   */
  async setCwd(chatId: number, cwd: string): Promise<void> {
    // Close old session — next getSession() call rebuilds it with the
    // new cwd threaded through to the AgentSession + SubagentManager.
    const oldSession = this.sessions.get(chatId);
    if (oldSession) {
      await oldSession.close();
      this.sessions.delete(chatId);
    }
    // cwd change rebuilds the session with a new sessionId → fresh sidecar.
    this._resetStats(chatId);

    let data = this.sessionData.get(chatId);
    if (!data) {
      data = {
        chatId,
        model: this.options.defaultModel,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        cwd,
      };
      this.sessionData.set(chatId, data);
    } else {
      data.cwd = cwd;
      data.lastActivity = new Date().toISOString();
    }
  }

  /**
   * Get the effective working directory for a chat: per-session override
   * (set via `/cd`) if present, otherwise the bot-global fallback.
   *
   * Returns undefined when neither is set — callers that need a real
   * path should fall back to `process.cwd()`.
   *
   * @param chatId - Telegram chat ID
   * @returns Effective cwd, or undefined when no override is configured
   */
  getCwd(chatId: number): string | undefined {
    const data = this.sessionData.get(chatId);
    return data?.cwd ?? this.options.botCwd;
  }

  /**
   * List this chat's resumable conversations for the `/sessions` switcher,
   * newest-active first. Sourced from the shared sidecar store (telegram
   * sidecars for this chatId) — the durable record of every conversation the
   * chat has held — with the currently-active one flagged.
   *
   * A brand-new conversation with no recorded turn yet has no sidecar and so
   * does not appear until its first turn is saved.
   */
  listChatSessions(chatId: number): ChatSessionInfo[] {
    const activeId = this.sessionData.get(chatId)?.sessionId;
    return listSessions()
      .filter(
        (s) => s.source === 'telegram' && s.telegramChatId === chatId && s.sessionId !== undefined,
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
    chatId: number,
    targetSessionId: string,
  ): Promise<{ ok: true; name?: string } | { ok: false; reason: 'not-found' | 'already-active' }> {
    // If a session creation is in flight for this chat, let it settle before we
    // inspect and close the live session. Otherwise the in-flight promise sets
    // the pre-switch session as live AFTER we adopt the target below, silently
    // reverting the switch. Awaiting materializes it so the close path evicts it
    // normally; a failed creation leaves this.sessions empty, which the `old`
    // guard already handles.
    const inflight = this.pendingSessions.get(chatId);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }

    // Already the live active conversation → no-op (avoid a needless rebuild).
    if (this.sessions.has(chatId) && this.sessionData.get(chatId)?.sessionId === targetSessionId) {
      return { ok: false, reason: 'already-active' };
    }

    const stored = loadSession(targetSessionId);
    if (!stored || stored.source !== 'telegram' || stored.telegramChatId !== chatId) {
      return { ok: false, reason: 'not-found' };
    }

    // Close the current live session (sidecar already persisted per-turn).
    const old = this.sessions.get(chatId);
    if (old) {
      // Guard the close (mirrors closeAll): a throwing close() must never block
      // the delete + target-state adoption below, or the stale session stays keyed
      // in this.sessions and the next getSession returns it unrebuilt.
      await old.close().catch((err) => console.error('Error closing session on switch:', err));
      this.sessions.delete(chatId);
    }
    // Drop in-memory stats so the resumed session hydrates the TARGET's stats
    // (name/turns/sessionId) from its sidecar on next access — never the
    // previous conversation's. autosave-failure notice re-arms for the switch.
    this.sessionStats.delete(chatId);
    this.autosaveFailureLogged.delete(chatId);

    // Adopt the target's identity + model/cwd and stage the resume.
    let data = this.sessionData.get(chatId);
    if (!data) {
      data = {
        chatId,
        model: stored.model,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
      this.sessionData.set(chatId, data);
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
    this.pendingResume.set(chatId, targetSessionId);
    return stored.name !== undefined ? { ok: true, name: stored.name } : { ok: true };
  }

  /**
   * Start a fresh conversation for the chat (the `/new` command), preserving the
   * previous one as a resumable session — its sidecar was persisted per-turn and
   * is never deleted here, so `/sessions` still lists it and `/switch` can return
   * to it. Behaviorally this is resetSession (close + fresh sessionId), exposed
   * under a name that reflects the switcher intent.
   */
  async newSession(chatId: number): Promise<void> {
    // resetSession → _resetStats already clears pendingResume; explicit here too
    // so intent is local and obvious.
    this.pendingResume.delete(chatId);
    await this.resetSession(chatId);
  }

  /**
   * Load session data from disk
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
          this.sessionData.set(data.chatId, data);
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
   * Save session data to disk
   */
  async saveSessions(): Promise<void> {
    try {
      await fs.mkdir(this.options.dataDir, { recursive: true });
      
      for (const [chatId, data] of this.sessionData.entries()) {
        const filePath = join(this.options.dataDir, `${chatId}.json`);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      }
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  /**
   * Close all sessions and clean up
   */
  async closeAll(): Promise<void> {
    await this.saveSessions();
    
    const closePromises = Array.from(this.sessions.values()).map(
      session => session.close().catch(err => console.error('Error closing session:', err))
    );
    
    await Promise.all(closePromises);
    this.sessions.clear();
  }

  /**
   * Get total number of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get total number of tracked chats
   */
  getChatCount(): number {
    return this.sessionData.size;
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
}
