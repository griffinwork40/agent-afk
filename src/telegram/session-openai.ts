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

import { OpenAICompatibleProvider } from '../agent/providers/index.js';
import { seedPersistedGrants } from '../agent/permissions-store.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup } from './mcp-session.js';
import { wireTelegramExecutors } from './wire-telegram-executors.js';
import type { AgentSession } from '../agent/session.js';
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

  // Shared executor + background + drain scaffolding.
  const wiring = wireTelegramExecutors({
    apiKey: sessionConfig.apiKey,
    model: sessionConfig.model,
    layeredBasePrompt: rawPrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras: {
      ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
  });
  const { subagentExecutor, skillExecutor, composeExecutor } = wiring.executors;

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
  // hard-refuses high-risk ops) -- see createTelegramAfkHookBundle +
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
    drainSubagents: wiring.drainSubagents,
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
  // same persisted-grant replay as the Anthropic branch.
  seedPersistedGrants(codexProvider);
  wiring.bindSession(session);

  return session;
}
