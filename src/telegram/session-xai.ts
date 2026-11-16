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

import { buildTelegramProvider } from './session-provider.js';
import { buildTelegramSession } from './session-builder.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildXaiTelegramSession(
  ctx: TelegramSessionBuildContext & { providerName: 'xai' | 'xai-oauth' },
): Promise<AgentSession> {
  const { sessionConfig, providerName } = ctx;

  return buildTelegramSession({
    ctx,
    wireExtras: {
      // Invariant: do NOT forward config.openaiBaseUrl -- XaiProvider ignores
      // AFK_OPENAI_BASE_URL and uses resolveXaiEndpoint + optional xaiBaseUrl.
      ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    },
    providerFactory: ({ executors }) => buildTelegramProvider(ctx, executors, providerName),
    // xAI branch: provider-specific config is only `xaiBaseUrl`.
    // Invariant: do NOT set openaiBaseUrl here (XaiProvider ignores it).
    providerConfig: {
      ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    },
  });
}
