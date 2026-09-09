/**
 * xAI / Grok provider branch of the Telegram session factory.
 *
 * Mirrors {@link buildOpenAiTelegramSession} grant/MCP/hook wiring, but
 * constructs {@link XaiProvider} so dual endpoints + SuperGrok OAuth work.
 * Never sets `openaiBaseUrl` from global OpenAI shim config (Grok uses
 * `resolveXaiEndpoint` / optional slot `xaiBaseUrl` only).
 *
 * @module telegram/session-xai
 */

import { AgentSession } from '../agent/session.js';
import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
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

export async function buildXaiTelegramSession(
  ctx: TelegramSessionBuildContext & { providerName: 'xai' | 'xai-oauth' },
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
    chatId,
    threadId,
    reportSession,
    providerName,
  } = ctx;

  const rawPrompt = layeredBasePrompt;
  const telegramAutoRouting = config.autoRouting?.telegram ?? false;
  const systemPrompt = typeof rawPrompt === 'string'
    ? assembleSystemPrompt(rawPrompt, telegramAutoRouting, 'telegram')
    : rawPrompt;

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

  // Executor wiring: one root manager shared by all three executors.
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    surface: 'telegram',
    parentSession: deferredParent,
    apiKey: sessionConfig.apiKey,
    model: sessionConfig.model,
    managerParentModel: sessionConfig.model,
    defaultSubagentModel: getDefaultSubagentModel(sessionConfig.model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(rawPrompt !== undefined ? { systemPrompt: rawPrompt } : {}),
    ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    ...(traceWriter !== null ? { traceWriter } : {}),
    backgroundRegistry,
  });

  // Slot/provider-forced oauth vs auto-routed apikey construction.
  const authMode = resolveXaiConstructionAuthMode(providerName, providerName === 'xai-oauth');
  const xaiProvider = new XaiProvider({
    surface: 'telegram',
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(authMode !== undefined ? { authMode } : {}),
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  });

  let sessionForMode: AgentSession | undefined;
  const hookBundle = createTelegramAfkHookBundle({
    memoryStore,
    getSession: () => sessionForMode,
    cwd: sessionCwd,
    traceWriter,
  });

  const session = attachMcpCleanup(constructTelegramSession({
    ...(sessionConfig.apiKey !== undefined ? { apiKey: sessionConfig.apiKey } : {}),
    model: sessionConfig.model,
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
    // Invariant: do NOT forward config.openaiBaseUrl — XaiProvider ignores
    // AFK_OPENAI_BASE_URL and uses resolveXaiEndpoint + optional xaiBaseUrl.
    ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    ...(sessionCwd !== undefined && sessionCwd.length > 0 ? { cwd: sessionCwd } : {}),
    provider: xaiProvider,
    hookRegistry: hookBundle.registry,
  }, { traceWriter }), mcpManager);

  sessionForMode = session;
  reportSession(session);
  // The former pathApprovalGrantRef.current wiring has been retired (#528).
  seedPersistedGrants(xaiProvider);
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
