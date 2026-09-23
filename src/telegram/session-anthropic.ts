/**
 * Anthropic-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure. The
 * behaviour-preserving asymmetries called out inline (which executors receive
 * `cwd`, which receive the trace writer) are load-bearing -- see each comment.
 *
 * Provider-specific nuances:
 * - `topLevelSurfaceAllowedTools` restricts the top-level tool allowlist.
 * - `apiKey` falls back to `config.apiKey` (Anthropic global key) then `''`.
 * - Both `baseUrl` and `openaiBaseUrl` are threaded through wireExtras.
 */

import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { buildTelegramSession } from './session-builder.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildAnthropicTelegramSession(
  ctx: TelegramSessionBuildContext,
): Promise<AgentSession> {
  const { sessionConfig, config, mcpManager, workspaceStore } = ctx;

  const telegramApiKey = sessionConfig.apiKey ?? config.apiKey ?? '';
  const telegramBaseUrl = config.baseUrl;
  // OpenAI-compatible endpoint (distinct from telegramBaseUrl, which is
  // Anthropic-only) -- threaded for parity with chat.ts's cliConfig.openaiBaseUrl wiring.
  const telegramOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

  return buildTelegramSession({
    ctx,
    apiKey: telegramApiKey,
    wireExtras: {
      // Behaviour-preserving asymmetry: the writer reaches the manager, the
      // `agent` executor and compose nodes, but NOT the `skill` executor or
      // the nested skill-executor factory (no `skillTraceWriter`) --
      // matching the pre-refactor wiring.
      ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
      ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
    providerFactory: ({ executors: { subagentExecutor, skillExecutor, composeExecutor } }) => {
      const allowedTools = topLevelSurfaceAllowedTools(mcpManager?.getMcpToolWireNames() ?? []);
      return new AnthropicDirectProvider({
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
    },
    // Anthropic branch: provider-specific config is only `baseUrl`.
    providerConfig: { ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}) },
  });
}
