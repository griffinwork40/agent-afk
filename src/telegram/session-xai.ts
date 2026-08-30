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
    reportSession,
    providerName,
  } = ctx;

  const rawPrompt = layeredBasePrompt;
  const telegramAutoRouting = config.autoRouting?.telegram ?? false;
  const systemPrompt = typeof rawPrompt === 'string'
    ? assembleSystemPrompt(rawPrompt, telegramAutoRouting, 'telegram')
    : rawPrompt;

  // Slot/provider-forced oauth vs auto-routed apikey construction.
  const authMode = resolveXaiConstructionAuthMode(providerName, providerName === 'xai-oauth');
  const xaiProvider = new XaiProvider({
    surface: 'telegram',
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

  return session;
}
