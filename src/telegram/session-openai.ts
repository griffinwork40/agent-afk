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

import { buildTelegramProvider } from './session-provider.js';
import { buildTelegramSession } from './session-builder.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildOpenAiTelegramSession(
  ctx: TelegramSessionBuildContext,
): Promise<AgentSession> {
  const { sessionConfig, config, workspaceStore } = ctx;

  // OpenAI-compatible endpoint for this branch's own top-level session
  // (parity with the Anthropic branch's telegramOpenaiBaseUrl).
  const codexOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

  return buildTelegramSession({
    ctx,
    wireExtras: {
      ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
    providerFactory: ({ executors }) => buildTelegramProvider(ctx, executors, 'openai-compatible'),
    // OpenAI branch: provider-specific config is only `openaiBaseUrl`.
    // Sets config.openaiBaseUrl -> effectiveBaseURL (openai-compatible/index.ts)
    // so this top-level OpenAI Telegram session reaches the configured shim
    // instead of defaulting to api.openai.com.
    providerConfig: {
      ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
    },
  });
}
