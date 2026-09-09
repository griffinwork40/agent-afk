/**
 * OpenAI-compatible-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure.
 *
 * Invariant: the provider is constructed EXPLICITLY here rather than letting
 * AgentSession build it internally, so this branch holds a handle to wire
 * path-approval. Without that handle `getGrantManager()` stays undefined and
 * BOTH path-approval and the bash interpreter denylist silently fail OPEN for
 * OpenAI-compatible Telegram sessions (PR #202 review H1).
 */

import { AgentSession } from '../agent/session.js';
import { OpenAICompatibleProvider } from '../agent/providers/index.js';
import { seedPersistedGrants } from '../agent/permissions-store.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { wireExecutors } from '../agent/session/wire-executors.js';
import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import { TelegramBgResultNotifier } from './bg-result-notifier.js';
import {
  getDefaultSubagentModel,
  getApiKeyForModel,
} from '../cli/shared-helpers.js';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildOpenAiTelegramSession(
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

  const rawPrompt = layeredBasePrompt;
  const telegramAutoRouting = config.autoRouting?.telegram ?? false;
  const systemPrompt = typeof rawPrompt === 'string'
    ? assembleSystemPrompt(rawPrompt, telegramAutoRouting, 'telegram')
    : rawPrompt;
  // OpenAI-compatible endpoint for this branch's own top-level session
  // (parity with the Anthropic branch's telegramOpenaiBaseUrl).
  const codexOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

  // Deferred parent proxy (session constructed after executors).
  let boundSession: AgentSession | undefined;
  const deferredParent = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() { return boundSession?.abortSignal ?? new AbortController().signal; },
    get hookRegistry() { return boundSession?.hookRegistry; },
  };

  // Background agent registry — enables `agent` tool with mode="background".
  const backgroundRegistry = new BackgroundAgentRegistry(
    traceWriter ? { traceWriter } : {},
  );
  const bgNotifier = new TelegramBgResultNotifier(backgroundRegistry, chatId, threadId);

  // Executor wiring: one root manager shared by all three executors so forked
  // subagents inherit cwd, abort graph, and read scope.
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    surface: 'telegram',
    parentSession: deferredParent,
    apiKey: sessionConfig.apiKey,
    model: sessionConfig.model,
    managerParentModel: sessionConfig.model,
    defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(rawPrompt !== undefined ? { systemPrompt: rawPrompt } : {}),
    ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    ...(traceWriter !== null ? { traceWriter } : {}),
    ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    backgroundRegistry,
  });

  // permissionMode is intentionally omitted here: AgentSession defaults
  // to 'default' (post-C2 fix), which is the correct mode for Telegram
  // sessions that rely on hook-based permission enforcement.
  // surface:'telegram' prevents the presence file mis-labeling as 'cli'.
  const codexProvider = new OpenAICompatibleProvider({
    surface: 'telegram',
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    workspaceStore,
  });
  // Same AFK autonomous-safety wiring as the Anthropic branch (live mode getter
  // registers the afk-mode gate + tracks `/afk on`; afkPromptForApproval:false
  // hard-refuses high-risk ops) — see createTelegramAfkHookBundle +
  // docs/afk-telegram-native-host.md.
  let codexSessionForMode: AgentSession | undefined;
  const codexHookBundle = createTelegramAfkHookBundle({
    memoryStore,
    getSession: () => codexSessionForMode,
    cwd: sessionCwd,
    traceWriter,
  });
  const session = attachMcpCleanup(constructTelegramSession({
    ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
    model: sessionConfig.model,
    // /switch resume: continue the target SDK session AND replay its saved
    // transcript (parity with the Anthropic branch). The openai-compatible
    // provider seeds prior turns from resumeHistory (messages.ts / query.ts),
    // so omitting it resumes an empty conversation.
    ...(sessionConfig.resume !== undefined ? { resume: sessionConfig.resume } : {}),
    ...(sessionConfig.sessionId !== undefined ? { sessionId: sessionConfig.sessionId } : {}),
    ...(sessionConfig.resumeHistory !== undefined
      ? { resumeHistory: sessionConfig.resumeHistory }
      : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    maxTurns: 100,
    // Cascade-abort and drain in-flight children before the writer seals.
    drainSubagents: async (reason) => {
      bgNotifier.dispose();
      await backgroundRegistry.cancelAll();
      return rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset');
    },
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
    // Sets config.openaiBaseUrl -> effectiveBaseURL (openai-compatible/index.ts)
    // so this top-level OpenAI Telegram session reaches the configured shim
    // instead of defaulting to api.openai.com.
    ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    provider: codexProvider,
    hookRegistry: codexHookBundle.registry,
  }, { traceWriter }), mcpManager);
  // Late-bind the mode source (see Anthropic branch) so the gate's getter
  // reads this session's live permission mode.
  codexSessionForMode = session;
  reportSession(session);
  // Seed persisted `persist` grants so the OpenAI Telegram surface gets the
  // same persisted-grant replay as the Anthropic branch. The former
  // pathApprovalGrantRef.current wiring has been retired (#528).
  seedPersistedGrants(codexProvider);
  boundSession = session;
  // Subagent-success rollup (parity with Anthropic branch).
  rootManager.setOnSubagentSucceeded((usage, costUsd) => {
    session.recordSubagentCompletion(usage, costUsd);
  });
  composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
    session.recordSubagentCompletion(usage, costUsd);
  });

  return session;
}
