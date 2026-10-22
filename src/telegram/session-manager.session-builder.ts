/**
 * Session-creation helper extracted from SessionManager.getSession.
 *
 * Builds the AgentConfig for a new session, applying the optional resume
 * target, injecting memory/companion primers, and registering the created
 * session with the registry and elicitation router.
 *
 * Invariant: all inputs are passed explicitly so this module is stateless
 * and testable in isolation. SessionManager wires the call via getSession;
 * its public surface is unchanged.
 *
 * @module telegram/session-manager.session-builder
 */

import type { IAgentSession, AgentConfig, AgentModelInput, ThinkingConfig, EffortLevel, PermissionMode } from '../agent/types.js';
import { injectHotMemory, injectGoalPrompt } from '../agent/memory/index.js';
import { injectCompanionPrimer } from '../agent/companion/index.js';
import { setElicitationRoute } from './elicitation-route-registry.js';
import { runTelegramReconcile } from '../agent/manifest/startup-reconcile.js';
import { loadSession } from '../cli/session-store.js';
import { resumeConfigFor } from '../cli/resume-session.js';
import { type TelegramRoute } from './route.js';
import type { SessionData } from './session-manager.js';

/** Options subset needed to build a session config. */
export interface SessionBuilderOptions {
  apiKey: string;
  settingSources?: ('user' | 'project')[];
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  botCwd?: string;
  /**
   * Bot-level permissionMode from afk.config.json. When set, it is forwarded
   * into every new session's AgentConfig so the session-lifecycle guard in
   * finalizeTelegramSession (session-lifecycle.ts) can downgrade 'plan' to
   * 'default' and honour other modes. Without this wire the guard is inert
   * (#3927).
   */
  permissionMode?: PermissionMode;
  createSession: (config: AgentConfig) => Promise<IAgentSession>;
  onResumptionOffer?: (route: TelegramRoute, text: string) => void | Promise<boolean>;
  defaultModel: AgentModelInput;
  /** Forwarded from `SessionManagerOptions.onInjectableForRoute`. */
  onInjectableForRoute?: (chatId: number, threadId: number | undefined) => () => void;
}

/** Live maps passed by reference from SessionManager. */
export interface SessionBuilderContext {
  sessions: Map<string, IAgentSession>;
  sessionData: Map<string, SessionData>;
  pendingResume: Map<string, string>;
  ensureRegistryHandle(route: TelegramRoute, data: SessionData): void;
}

/**
 * Build and register a brand-new AgentSession for the given route + data.
 *
 * Handles resume config injection (/switch), memory injection, registry wiring,
 * elicitation-route seeding, and reconciliation offer. Must NOT be called when
 * a session already exists for this route -- that guard lives in getSession.
 */
export async function buildAndRegisterSession(
  route: TelegramRoute,
  key: string,
  data: SessionData,
  opts: SessionBuilderOptions,
  sc: SessionBuilderContext,
): Promise<IAgentSession> {
  const config: AgentConfig = {
    model: data.model,
    apiKey: opts.apiKey,
    // Trusted top-level interactive Telegram session: LSP install consent
    // prompts are reachable via elicitation. The dispatcher enforces the rest
    // of the predicate structurally (no parent/subagent/non-interactive).
    lspInstallAllowed: true,
    telegramChatId: route.chatId,
    ...(route.threadId !== undefined ? { telegramThreadId: route.threadId } : {}),
    // Wire the per-session idle-wake hook when the SessionManager was
    // constructed with onInjectableForRoute. The callback is bound here (at
    // session-creation time) so it captures the exact route and is ready to
    // wake THIS session when a background subagent result lands.
    ...(opts.onInjectableForRoute !== undefined
      ? { telegramOnInjectable: opts.onInjectableForRoute(route.chatId, route.threadId) }
      : {}),
  };
  if (opts.settingSources?.length) {
    config.settingSources = opts.settingSources;
  }
  if (opts.thinking !== undefined) {
    config.thinking = opts.thinking;
  }
  if (opts.effort !== undefined) {
    config.effort = opts.effort;
  }
  // Forward bot-level permissionMode so the plan-mode guard in
  // finalizeTelegramSession (session-lifecycle.ts) is reachable. Without this
  // wire, sessionConfig.permissionMode is always undefined and the guard is
  // inert against `afk config set permissionMode plan` (#3927).
  if (opts.permissionMode !== undefined) {
    config.permissionMode = opts.permissionMode;
  }
  // Per-session cwd (set via /cd) overrides the bot-global botCwd.
  // When neither is set, leave config.cwd undefined and let the
  // downstream createSession factory fall back to its own default.
  const effectiveCwd = data.cwd ?? opts.botCwd;
  if (effectiveCwd !== undefined && effectiveCwd.length > 0) {
    config.cwd = effectiveCwd;
  }
  // /switch: continue a staged prior conversation instead of starting fresh.
  // Consumed after a successful build below -- a failed createSession leaves it
  // staged so the next getSession retries the resume; teardown via _resetStats
  // (/clear, model switch, /cd) still clears any stale target.
  // Load the target sidecar and populate the SAME resume fields the CLI does
  // (resume + sessionId + resumeHistory) so the providers actually replay the
  // saved transcript. Forwarding only config.resume (the SDK id) resumes an
  // empty conversation. Mirrors resumeConfigFor (src/cli/resume-session.ts).
  const resumeTarget = sc.pendingResume.get(key);
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

  const session = await opts.createSession(injectGoalPrompt(injectCompanionPrimer(injectHotMemory(config))));
  sc.sessions.set(key, session);
  sc.sessionData.set(key, data);
  // Register with the session registry (best-effort: never orphan the live session).
  try { sc.ensureRegistryHandle(route, data); } catch { /* non-fatal */ }
  // Seed elicitation routing before the first turn starts. ask_question can
  // suspend that turn, so waiting for recordTelegramTurn (onComplete) would
  // deadlock a topic's first question on the General-route fallback.
  if (session.sessionId) {
    setElicitationRoute(session.sessionId, route);
    data.sessionId = session.sessionId;
  }
  // Wave-manifest reconciliation: surface resumption offers for unfinished
  // work. Telegram is interactive -- fire-and-forget, never blocks creation.
  if (opts.onResumptionOffer) {
    void runTelegramReconcile(session.sessionId ?? '', route, opts.onResumptionOffer);
  }
  // Consume the staged resume only after a successful build: a thrown
  // createSession must leave it staged so the next getSession retries the
  // resume instead of silently starting a fresh conversation.
  if (resumeTarget !== undefined) sc.pendingResume.delete(key);
  return session;
}
