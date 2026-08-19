/**
 * Anthropic-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure. The
 * behaviour-preserving asymmetries called out inline (which executors receive
 * `cwd`, which receive the trace writer) are load-bearing — see each comment.
 */

import { AgentSession } from '../agent/session.js';
import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { seedPersistedGrants } from '../agent/permissions-store.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { wireExecutors } from '../agent/session/wire-executors.js';
import {
  getDefaultSubagentModel,
  getApiKeyForModel,
} from '../cli/shared-helpers.js';
import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { TelegramBgResultNotifier } from './bg-result-notifier.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildAnthropicTelegramSession(
  ctx: TelegramSessionBuildContext,
): Promise<AgentSession> {
  const {
    sessionConfig,
    config,
    layeredBasePrompt,
    sessionCwd,
    maxOutputTokens,
    maxToolUseIterations,
    traceWriter,
    mcpManager,
    memoryStore,
    workspaceStore,
    chatId,
    reportSession,
  } = ctx;

  let boundSession: AgentSession | undefined;
  const telegramApiKey = sessionConfig.apiKey ?? config.apiKey ?? '';
  const telegramBaseUrl = config.baseUrl;
  // OpenAI-compatible endpoint (distinct from telegramBaseUrl, which is
  // Anthropic-only) — threaded for parity with chat.ts's cliConfig.openaiBaseUrl wiring.
  const telegramOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;
  // The session is constructed after the executors, so the parent view
  // they fork from reads through `boundSession` lazily.
  const deferredParent = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() { return boundSession?.abortSignal ?? new AbortController().signal; },
    // Live registry so forked subagents resolve it via forkSubagent's
    // parent fallback (SubagentStart/Stop + shadow-verify nudge).
    get hookRegistry() { return boundSession?.hookRegistry; },
  };

  // Background agent registry — enables `agent` tool with mode="background"
  // on Telegram. Mirrors the REPL's bootstrap-infra.ts wiring. Per-session
  // lifetime: cancelAll is called via drainSubagents on session close.
  const backgroundRegistry = new BackgroundAgentRegistry(
    traceWriter ? { traceWriter } : {},
  );
  const bgNotifier = new TelegramBgResultNotifier(backgroundRegistry, chatId);

  // Invariant: ONE root manager per session, shared by all three
  // executors. Inherit configured-or-host cwd so forked subagents stay
  // in the same working tree as the parent session — important when the
  // bot is pointed at a worktree via AFK_TELEGRAM_CWD.
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    // Origin attribution: forked children inherit origin 'telegram'.
    surface: 'telegram',
    parentSession: deferredParent,
    apiKey: telegramApiKey,
    model: sessionConfig.model,
    // The Telegram credential is resolved for the session model itself,
    // so it is also the manager's credential-fallback anchor.
    managerParentModel: sessionConfig.model,
    defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
    resolveApiKeyForModel: getApiKeyForModel,
    // Framework base + operator overlay, but NOT ROUTING_DIRECTIVE /
    // TOOL_SYSTEM_PROMPT — keeps children and DAG workers from recursing
    // into skills or nested DAGs.
    ...(layeredBasePrompt !== undefined ? { systemPrompt: layeredBasePrompt } : {}),
    ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
    ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
    // Behaviour-preserving asymmetry: cwd anchors the root manager, the
    // named-agent scan and compose DAG nodes, but NOT the `agent`/`skill`
    // executors (no `nestedCwd`) — matching the pre-refactor wiring.
    // Widening it to nestedCwd would change depth >= 2 anchoring.
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    // Behaviour-preserving asymmetry: the writer reaches the manager, the
    // `agent` executor and compose nodes, but NOT the `skill` executor or
    // the nested skill-executor factory (no `skillTraceWriter`) —
    // matching the pre-refactor wiring.
    ...(traceWriter !== null ? { traceWriter } : {}),
    ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    backgroundRegistry,
  });

  const allowedTools = topLevelSurfaceAllowedTools(mcpManager?.getMcpToolWireNames() ?? []);
  const directProvider = new AnthropicDirectProvider({
    permissions: { allowedTools },
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    workspaceStore,
    // Tag the presence file (~/.afk/state/presence/<id>.json) and
    // get_runtime_state as the Telegram surface. Without this the provider
    // defaults to 'cli' (anthropic-direct/index.ts) and `/watch`
    // mis-classifies Telegram sessions as CLI. The hook registry already
    // receives 'telegram' below — this aligns the provider-owned surface
    // (presence/runtime-state) with the hook-registry surface.
    surface: 'telegram',
  });

  // Bind after session creation so deferred parent proxy resolves.
  const rawPrompt = layeredBasePrompt;
  const telegramAutoRouting = config.autoRouting?.telegram ?? false;
  const systemPrompt = typeof rawPrompt === 'string'
    ? assembleSystemPrompt(rawPrompt, telegramAutoRouting, 'telegram')
    : rawPrompt;

  // permissionMode is omitted from session CONSTRUCTION: AgentSession
  // defaults to 'default'. A Telegram session becomes 'autonomous' only via
  // an explicit `/afk on` (handlers/afk.ts) calling setPermissionMode —
  // never at construction. The hook bundle carries the AFK autonomous-safety
  // wiring (live mode getter → registers the afk-mode gate + tracks `/afk
  // on`; afkPromptForApproval:false → hard-refuse high-risk ops) — see
  // createTelegramAfkHookBundle + docs/afk-telegram-native-host.md.
  let telegramSessionForMode: AgentSession | undefined;
  const telegramHookBundle = createTelegramAfkHookBundle({
    memoryStore,
    getSession: () => telegramSessionForMode,
    cwd: sessionCwd,
    traceWriter,
  });
  const session = attachMcpCleanup(constructTelegramSession({
    ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
    model: sessionConfig.model,
    // /switch resumes a prior conversation: thread the target SDK session
    // id AND the saved transcript so the AgentSession actually replays it
    // (see SessionManager.switchToSession + resumeConfigFor). Forwarding
    // only `resume` (the SDK id) resumes an EMPTY conversation — the
    // provider replays prior turns solely from resumeHistory
    // (anthropic-direct/index.ts resumeHistoryToMessages). sessionId is
    // threaded too because the provider prefers config.sessionId over
    // config.resume as the resumed id.
    ...(sessionConfig.resume !== undefined ? { resume: sessionConfig.resume } : {}),
    ...(sessionConfig.sessionId !== undefined ? { sessionId: sessionConfig.sessionId } : {}),
    ...(sessionConfig.resumeHistory !== undefined
      ? { resumeHistory: sessionConfig.resumeHistory }
      : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    maxTurns: 100,
    // Cascade-abort and drain in-flight children before the writer seals, so a
    // wave still running when this session ends emits real `cancelled` rows
    // instead of vanishing (#733). Background jobs are cancelled alongside the
    // SubagentManager drain; the notifier is disposed so the settled listener
    // doesn't fire after the session is gone.
    drainSubagents: async (reason) => {
      bgNotifier.dispose();
      await backgroundRegistry.cancelAll();
      return rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset');
    },
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
    ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
    // Pipe cwd through to tool handlers so bash/grep honor the
    // configured worktree (AFK_TELEGRAM_CWD or sessionConfig.cwd).
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    provider: directProvider,
    hookRegistry: telegramHookBundle.registry,
  }, { traceWriter }), mcpManager);
  // Late-bind the mode source so the registry's getPermissionMode getter
  // (built above, before the session existed) reads this session's LIVE
  // permission mode — flipped by /afk on (handlers/afk.ts).
  telegramSessionForMode = session;
  reportSession(session);
  // Wire the path-approval grant ref to the provider so elicitation
  // approvals mutate readRoots / writeRoots on the right backend.
  telegramHookBundle.pathApprovalGrantRef.current = directProvider;
  // Seed read/write roots from persisted `persist` grants so the
  // prompt's "future sessions inherit it" promise holds. No-op when none.
  seedPersistedGrants(directProvider);
  boundSession = session;
  // Subagent-success rollup: wire both the root manager and the compose
  // executor so all subagent token/cost data (including compose DAG nodes)
  // accumulates into this session's session_sealed telemetry. Late-bound here
  // because the session is constructed after the executors.
  rootManager.setOnSubagentSucceeded((usage, costUsd) => {
    session.recordSubagentCompletion(usage, costUsd);
  });
  composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
    session.recordSubagentCompletion(usage, costUsd);
  });
  return session;
}
