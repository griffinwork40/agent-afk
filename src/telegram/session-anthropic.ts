/**
 * Anthropic-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure. The
 * behaviour-preserving asymmetries called out inline (which executors receive
 * `cwd`, which receive the trace writer) are load-bearing -- see each comment.
 */

import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { seedPersistedGrants } from '../agent/permissions-store.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import { wireTelegramExecutors } from './wire-telegram-executors.js';
import type { AgentSession } from '../agent/session.js';
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
    threadId,
    reportSession,
  } = ctx;

  const telegramApiKey = sessionConfig.apiKey ?? config.apiKey ?? '';
  const telegramBaseUrl = config.baseUrl;
  // OpenAI-compatible endpoint (distinct from telegramBaseUrl, which is
  // Anthropic-only) -- threaded for parity with chat.ts's cliConfig.openaiBaseUrl wiring.
  const telegramOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

  // Shared executor + background + drain scaffolding.
  const wiring = wireTelegramExecutors({
    apiKey: telegramApiKey,
    model: sessionConfig.model,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras: {
      // Behaviour-preserving asymmetry: the writer reaches the manager, the
      // `agent` executor and compose nodes, but NOT the `skill` executor or
      // the nested skill-executor factory (no `skillTraceWriter`) --
      // matching the pre-refactor wiring.
      ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
      ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
  });
  const { subagentExecutor, skillExecutor, composeExecutor } = wiring.executors;

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
    // mis-classifies Telegram sessions as CLI.
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
  // an explicit `/afk on` (handlers/afk.ts) calling setPermissionMode --
  // never at construction. The hook bundle carries the AFK autonomous-safety
  // wiring (live mode getter -> registers the afk-mode gate + tracks `/afk
  // on`; afkPromptForApproval:false -> hard-refuse high-risk ops) -- see
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
    // only `resume` (the SDK id) resumes an EMPTY conversation -- the
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
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    maxTurns: 100,
    drainSubagents: wiring.drainSubagents,
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
  // permission mode -- flipped by /afk on (handlers/afk.ts).
  telegramSessionForMode = session;
  reportSession(session);
  // Seed read/write roots from persisted `persist` grants so the
  // prompt's "future sessions inherit it" promise holds. No-op when none.
  seedPersistedGrants(directProvider);
  wiring.bindSession(session);
  return session;
}
