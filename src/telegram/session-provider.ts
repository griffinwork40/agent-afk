/** Fully wired Telegram providers, shared by the primary and fallback builders. */
import { AnthropicDirectProvider, OpenAICompatibleProvider, providerForModel } from '../agent/providers/index.js';
import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import type { WiredExecutors } from '../agent/session/wire-executors.js';
import type { TelegramSessionBuildContext } from './session-context.js';

/** Keep each branch's existing tool/store wiring when constructing another model. */
export function buildTelegramProvider(
  ctx: TelegramSessionBuildContext,
  { subagentExecutor, skillExecutor, composeExecutor }: WiredExecutors,
  family = providerForModel(String(ctx.sessionConfig.model)),
) {
  const shared = {
    surface: 'telegram' as const,
    subagentExecutor, skillExecutor, composeExecutor,
    ...(ctx.mcpManager !== undefined ? { mcpManager: ctx.mcpManager } : {}),
    ...(ctx.stateStore !== undefined ? { stateStore: ctx.stateStore } : {}),
  };
  if (family === 'xai' || family === 'xai-oauth') {
    const authMode = resolveXaiConstructionAuthMode(family, family === 'xai-oauth');
    return new XaiProvider({ ...shared, ...(authMode !== undefined ? { authMode } : {}) });
  }
  if (family !== 'anthropic-direct') {
    return new OpenAICompatibleProvider({ ...shared, workspaceStore: ctx.workspaceStore });
  }
  return new AnthropicDirectProvider({
    ...shared,
    workspaceStore: ctx.workspaceStore,
    permissions: { allowedTools: topLevelSurfaceAllowedTools(ctx.mcpManager?.getMcpToolWireNames() ?? []) },
  });
}
