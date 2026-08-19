import type { ModelProvider } from '../../../agent/provider.js';
import type { MemoryStore } from '../../../agent/memory/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/workspace-store.js';
import type { SubagentExecutor } from '../../../agent/tools/subagent-executor.js';
import type { SkillExecutor } from '../../../agent/tools/skill-executor.js';
import type { ComposeExecutor } from '../../../agent/tools/compose-executor.js';
import type { McpManager } from '../../../agent/mcp/index.js';
import { parseProvider } from '../../shared-helpers.js';
import { topLevelSurfaceAllowedTools } from '../../../agent/tools/top-level-allowlist.js';
import { AnthropicDirectProvider } from '../../../agent/providers/anthropic-direct/index.js';
import { providerForModel } from '../../../agent/providers/index.js';
import { createMemoizedProviderFactory } from './provider-factory.js';
import type { CliConfig } from '../../config.js';
import type { CliOptions } from './shared.js';
import type { FastModeController } from '../../../agent/fast-mode.js';

/**
 * Build a fully-wired, per-family-memoized provider factory the
 * ProviderRouter calls to resolve the active provider — at session init and
 * again on each cross-family `/model` swap (NOT every turn; the router
 * reuses the active inner across turns of the same family). The builder
 * closes over the executors, memoryStore, mcpManager, and openaiBaseUrl so
 * every provider it builds (regardless of family) carries the full tool
 * surface — agent/skill/compose tools, MCP bridges, and the shared
 * MemoryStore. This is what allows mid-session `/model` cross-family
 * switches (e.g. Claude → GPT) without losing any tool wiring.
 *
 * When `--provider` is explicit (`options.provider` is set), `parseProvider`
 * returns a single fixed provider, so the builder always yields the same
 * family. This preserves the AFK_PROVIDER / --provider escape-hatch behavior.
 *
 * Memoization invariant: `startupProvider` (returned here) MUST be the same
 * instance the router's `buildInner` reuses for turn 1, or `/allow-dir`
 * grants land on a dead instance and are silently dropped. The cache key
 * mirrors `parseProvider`'s own routing: the `--provider` override first (a
 * fixed family), otherwise `providerForModel` with the same `openaiBaseUrl`
 * hint — so a key never aliases two different provider families.
 *
 * Call this AFTER MCP connect (`bootstrap-mcp.ts`) — `buildProvider` and
 * `mcpToolWireNames` close over `a.mcpManager`.
 */
export function createReplProviders(a: {
  options: CliOptions;
  cliConfig: CliConfig;
  sessionModel: string;
  subagentExecutor: SubagentExecutor;
  skillExecutor: SkillExecutor;
  composeExecutor: ComposeExecutor;
  memoryStore: MemoryStore;
  workspaceStore?: WorkspaceStore;
  mcpManager: McpManager | undefined;
  fastModeController: FastModeController;
}): { providerFactory: (m: string | undefined) => ModelProvider; startupProvider: ModelProvider } {
  // The MCP tool wire names are stable for the manager lifetime, so they can be
  // captured once in the closure without re-querying on every build.
  const mcpToolWireNames = a.mcpManager?.getMcpToolWireNames() ?? [];
  const buildProvider = (model: string | undefined): ModelProvider =>
    parseProvider(a.options.provider, {
      subagentExecutor: a.subagentExecutor,
      skillExecutor: a.skillExecutor,
      composeExecutor: a.composeExecutor,
      memoryStore: a.memoryStore,
      ...(a.workspaceStore !== undefined ? { workspaceStore: a.workspaceStore } : {}),
      model: model !== undefined ? model : String(a.sessionModel),
      ...(a.cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: a.cliConfig.openaiBaseUrl } : {}),
      ...(a.mcpManager !== undefined ? { mcpManager: a.mcpManager } : {}),
      fastModeController: a.fastModeController,
    })
    ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: topLevelSurfaceAllowedTools(mcpToolWireNames),
      },
      subagentExecutor: a.subagentExecutor,
      skillExecutor: a.skillExecutor,
      composeExecutor: a.composeExecutor,
      memoryStore: a.memoryStore,
      ...(a.workspaceStore !== undefined ? { workspaceStore: a.workspaceStore } : {}),
      surface: 'cli',
      fastModeController: a.fastModeController,
      ...(a.mcpManager !== undefined ? { mcpManager: a.mcpManager } : {}),
    });

  // Memoize by provider family so the `startupProvider` built below for /allow-dir
  // wiring is the SAME instance the router's buildInner reuses for turn 1.
  // Without this, the two call sites mint separate instances with independent
  // read/write grant roots, and /allow-dir grants are silently dropped (they land
  // on the startup instance, never on the query runner). The cache key mirrors
  // parseProvider's own routing: the --provider override first (a fixed family),
  // otherwise providerForModel with the same openaiBaseUrl hint — so a key never
  // aliases two different provider families.
  const providerFactory = createMemoizedProviderFactory(buildProvider, (model) =>
    a.options.provider ??
    providerForModel(
      model !== undefined ? model : String(a.sessionModel),
      a.cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: a.cliConfig.openaiBaseUrl } : undefined,
    ),
  );

  // Build the startup provider (for /allow-dir wiring). Because the factory
  // memoizes by family, this returns the SAME instance the router reuses for
  // turn 1, so grants added via setAllowDirDispatcher reach the query runner.
  const startupProvider = providerFactory(String(a.sessionModel));

  return { providerFactory, startupProvider };
}
