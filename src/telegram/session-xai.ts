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

import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
import { buildTelegramSession } from './session-builder.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildXaiTelegramSession(
  ctx: TelegramSessionBuildContext & { providerName: 'xai' | 'xai-oauth' },
): Promise<AgentSession> {
  const { sessionConfig, mcpManager, providerName } = ctx;

  return buildTelegramSession({
    ctx,
    wireExtras: {
      // Invariant: do NOT forward config.openaiBaseUrl -- XaiProvider ignores
      // AFK_OPENAI_BASE_URL and uses resolveXaiEndpoint + optional xaiBaseUrl.
      ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    },
    providerFactory: ({ executors: { subagentExecutor, skillExecutor, composeExecutor } }) => {
      // Slot/provider-forced oauth vs auto-routed apikey construction.
      const authMode = resolveXaiConstructionAuthMode(providerName, providerName === 'xai-oauth');
      return new XaiProvider({
        surface: 'telegram',
        subagentExecutor,
        skillExecutor,
        composeExecutor,
        ...(authMode !== undefined ? { authMode } : {}),
        ...(mcpManager !== undefined ? { mcpManager } : {}),
      });
    },
    // xAI branch: provider-specific config is only `xaiBaseUrl`.
    // Invariant: do NOT set openaiBaseUrl here (XaiProvider ignores it).
    providerConfig: {
      ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    },
  });
}
