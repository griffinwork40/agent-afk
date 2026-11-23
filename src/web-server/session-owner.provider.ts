/** Per-session fallback providers with the web surface's existing tool wiring. */
import { AnthropicDirectProvider, OpenAICompatibleProvider, providerForModel } from '../agent/providers/index.js';
import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
import { seedPersistedGrants } from '../agent/permissions-store.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { injectedProviderWiring } from '../cli/provider-fallback-factory.js';
import type { ModelProvider } from '../agent/provider.js';
import type { WiredExecutors } from '../agent/session/wire-executors.js';
import type { McpManager } from '../agent/mcp/index.js';
import type { WorkspaceStore } from '../agent/workspace/index.js';
import type { FastModeController } from '../agent/fast-mode.js';

interface WebProviderOptions {
  model: string;
  executors: WiredExecutors;
  mcpManager: McpManager | undefined;
  workspaceStore: WorkspaceStore;
  fastModeController?: FastModeController;
}

/** Keep the existing primary path when no fallback is configured or a provider is pinned. */
export function webProviderWiring(opts: WebProviderOptions) {
  const shared = {
    surface: 'web' as const,
    permissions: { allowedTools: topLevelSurfaceAllowedTools(opts.mcpManager?.getMcpToolWireNames() ?? []) },
    subagentExecutor: opts.executors.subagentExecutor,
    skillExecutor: opts.executors.skillExecutor,
    composeExecutor: opts.executors.composeExecutor,
    ...(opts.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
    workspaceStore: opts.workspaceStore,
    ...(opts.fastModeController !== undefined ? { fastModeController: opts.fastModeController } : {}),
  };
  const primary = new AnthropicDirectProvider(shared);
  const wiring = injectedProviderWiring({
    model: opts.model,
    familyOf: providerForModel,
    build: (model): ModelProvider => {
      const family = providerForModel(model);
      // primary.name is 'anthropic-direct'; providerForModel returns that same
      // string for every Anthropic model, so Anthropic requests reuse the shared
      // primary instance rather than constructing a second provider.
      if (family === primary.name) return primary;
      const authMode = family === 'xai' || family === 'xai-oauth'
        ? resolveXaiConstructionAuthMode(family, family === 'xai-oauth') : undefined;
      const provider = family === 'xai' || family === 'xai-oauth'
        ? new XaiProvider({ ...shared, ...(authMode !== undefined ? { authMode } : {}) })
        : new OpenAICompatibleProvider(shared);
      const query = provider.query.bind(provider);
      provider.query = (args) => {
        // query initializes cwd roots synchronously; restore persisted grants
        // afterwards, before the iterator can execute a tool (Telegram parity).
        const inner = query(args);
        seedPersistedGrants(provider);
        return inner;
      };
      return provider;
    },
  });
  return { provider: primary, ...(wiring.providerFactory !== undefined ? { providerFactory: wiring.providerFactory } : {}) };
}
