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

  // permissionMode is intentionally omitted here: AgentSession defaults
  // to 'default' (post-C2 fix), which is the correct mode for Telegram
  // sessions that rely on hook-based permission enforcement.
  // baseURL / apiKey / cwd / roots flow through the per-query config (not the
  // constructor), so omitting them here is behavior-preserving vs.
  // resolveProvider(). surface:'telegram' is the lone constructor arg — there
  // is no per-query surface field — and prevents the presence file
  // mis-labeling Telegram sessions as 'cli' in `/watch`.
  const codexProvider = new OpenAICompatibleProvider({
    surface: 'telegram',
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
    maxTurns: 100,
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
  // Wire the path-approval grant ref + seed persisted `persist` grants so
  // the OpenAI Telegram surface gets the same restricted-path prompts and
  // persisted-grant replay as the Anthropic branch.
  codexHookBundle.pathApprovalGrantRef.current = codexProvider;
  seedPersistedGrants(codexProvider);

  return session;
}
