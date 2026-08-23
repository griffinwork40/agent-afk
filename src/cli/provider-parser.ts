import { providerForModel, AnthropicDirectProvider } from '../agent/providers/index.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';
import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
import type { ModelProvider } from '../agent/provider.js';
import { env } from '../config/env.js';
import { BUILTIN_TOOL_NAMES } from '../agent/tools/schemas.js';
import { MEMORY_TOOL_NAMES } from '../agent/memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../agent/awareness/index.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../agent/tools/handlers/exit-plan-mode.js';
import { WORKSPACE_TOOL_NAMES } from '../agent/workspace/index.js';

const VALID_PROVIDERS: readonly string[] = [
  'anthropic',
  'anthropic-direct',
  'openai-codex',
  'openai',
  'openai-compatible',
  'xai',
  'xai-oauth',
];

export type ParseProviderOptions = {
  subagentExecutor?: import('../agent/tools/subagent-executor.js').SubagentExecutor;
  skillExecutor?: import('../agent/tools/skill-executor.js').SkillExecutor;
  composeExecutor?: import('../agent/tools/compose-executor.js').ComposeExecutor;
  /** Shared MemoryStore to pass into providers so only one SQLite DB is opened. */
  memoryStore?: import('../agent/memory/index.js').MemoryStore;
  /** Shared WorkspaceStore so sibling sub-agents share one ephemeral scratchpad. */
  workspaceStore?: import('../agent/workspace/workspace-store.js').WorkspaceStore;
  /**
   * Optional MCP manager. When supplied, every tool exposed by a
   * `connected` MCP server is added to the provider's allow-list AND
   * the provider's tool schema set (via the provider's own constructor).
   */
  mcpManager?: import('../agent/mcp/index.js').McpManager;
  /**
   * Model string used to auto-select a provider when `raw` is undefined.
   * Wired through providerForModel() — accepts Claude short aliases, full
   * `claude-*` ids, GPT/o-series, codex-*, and HF-style `org/model` ids.
   */
  model?: string;
  /**
   * Base URL for OpenAI-compatible endpoint (e.g. local mlx_lm.server,
   * Ollama OpenAI-compat). Forwarded to OpenAICompatibleProvider as
   * `baseURL`. Ignored when the selected provider is anthropic-direct.
   */
  openaiBaseUrl?: string;
  fastModeController?: import('../agent/fast-mode.js').FastModeController;
};

/**
 * Parse a provider string into a ModelProvider instance.
 * Optionally accepts executors to enable the Agent and Skill tools.
 *
 * When `raw` is undefined AND `opts.model` is supplied, the function consults
 * `providerForModel(model)` to auto-select between `anthropic-direct` and
 * `openai-compatible`. This is what lets `AFK_OPENAI_BASE_URL=… AFK_MODEL=mlx-community/…`
 * route to the local OpenAI-shim server without an explicit `--provider` flag.
 * Without a model hint, returns `undefined` so the CLI falls back to its
 * hardcoded AnthropicDirectProvider (legacy default; preserved for callers
 * that pass `parseProvider(undefined)` with no model context).
 *
 * Returns `undefined` for `'openai-codex'` so the session falls through to
 * the model-router in `providers/index.ts:resolveProvider` — which, after
 * slice 5 of the 2026-05-18 provider refactor, routes GPT/o-series models
 * to `OpenAICompatibleProvider`. Keeping the value in `VALID_PROVIDERS` is
 * pure backward-compat (existing scripts that pass `--provider openai-codex`
 * keep working).
 */
export function parseProvider(
  raw: string | undefined,
  opts?: ParseProviderOptions,
): ModelProvider | undefined {
  // Auto-route: when --provider is omitted but a model hint is available,
  // consult the model-router so HF-style local model ids (mlx-community/…,
  // TheBloke/…) and GPT/o-series default to openai-compatible without the
  // operator having to type `--provider openai-compatible` every launch.
  //
  // We thread `openaiBaseUrl` into the router so its Tier 4 env-hint fires
  // off `cliConfig.openaiBaseUrl` (already normalized) rather than re-reading
  // raw env — guarantees parity with the rest of the bootstrap flow when
  // a test or caller has overridden the URL.
  // Preserve whether the operator/env explicitly named a provider — auto-route
  // from model heuristics must NOT inherit forced-apikey construction.
  // AFK_PROVIDER counts as explicit (same as --provider) for xai force modes.
  const explicitProviderRaw = raw?.trim().toLowerCase() ?? '';
  const envProviderRaw = (env.AFK_PROVIDER ?? '').trim().toLowerCase();
  const wasExplicitProvider =
    explicitProviderRaw.length > 0 ||
    envProviderRaw === 'xai' ||
    envProviderRaw === 'xai-oauth' ||
    envProviderRaw === 'xai_oauth';

  let effective = raw;
  if (effective === undefined && opts?.model !== undefined) {
    const routed = providerForModel(opts.model, {
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
    });
    // Only override for non-Anthropic routes — Anthropic is the legacy
    // default the caller's fallback already constructs, so leaving
    // `effective` undefined preserves the existing executor wiring path.
    if (routed === 'openai-compatible') effective = 'openai-compatible';
    if (routed === 'xai' || routed === 'xai-oauth') effective = routed;
  }
  if (effective === undefined) return undefined;
  if (!VALID_PROVIDERS.includes(effective)) {
    throw new Error(`Invalid --provider value: ${effective}. Expected one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const allowedToolsFor = (): string[] => {
    // Awareness tools (`get_runtime_state`) are registered unconditionally by
    // every provider (see `anthropic-direct/index.ts`, `openai-compatible/index.ts`),
    // so the allowlist must include them or the dispatcher's permission gate
    // rejects the registered handler. Source of truth: `agent/awareness/tool.ts`.
    // `exit_plan_mode` is registered only while in plan mode, but the allowlist
    // is static (snapshotted at construction), so its name must be present here
    // or the gate rejects it the moment the model calls it. Harmless when the
    // tool is not registered (the dispatcher just never routes to it).
    const list = [
      ...BUILTIN_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...AWARENESS_TOOL_NAMES,
      ...WORKSPACE_TOOL_NAMES,
      EXIT_PLAN_MODE_TOOL_NAME,
    ];
    if (opts?.subagentExecutor) list.push('agent');
    if (opts?.skillExecutor) list.push('skill');
    if (opts?.composeExecutor) list.push('compose');
    // Bridge: every MCP-bridged tool must appear on the permission allow-list
    // or the dispatcher's `enforcePermissions()` will reject it as an
    // unknown tool. Wire names are stable for the manager's lifetime.
    if (opts?.mcpManager) list.push(...opts.mcpManager.getMcpToolWireNames());
    return list;
  };
  if (effective === 'anthropic' || effective === 'anthropic-direct') {
    return new AnthropicDirectProvider({
      permissions: { allowedTools: allowedToolsFor() },
      subagentExecutor: opts?.subagentExecutor,
      skillExecutor: opts?.skillExecutor,
      composeExecutor: opts?.composeExecutor,
      ...(opts?.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
      ...(opts?.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
      ...(opts?.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
      ...(opts?.fastModeController !== undefined ? { fastModeController: opts.fastModeController } : {}),
    });
  }
  if (effective === 'openai' || effective === 'openai-compatible') {
    // Same allowed-tools shape as anthropic-direct so the model gets the
    // same builtin surface (bash/read_file/edit_file/etc.) plus optional
    // agent/skill/compose when executors are injected.
    return new OpenAICompatibleProvider({
      permissions: { allowedTools: allowedToolsFor() },
      ...(opts?.subagentExecutor !== undefined ? { subagentExecutor: opts.subagentExecutor } : {}),
      ...(opts?.skillExecutor !== undefined ? { skillExecutor: opts.skillExecutor } : {}),
      ...(opts?.composeExecutor !== undefined ? { composeExecutor: opts.composeExecutor } : {}),
      ...(opts?.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
      ...(opts?.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
      ...(opts?.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
      ...(opts?.openaiBaseUrl !== undefined ? { baseURL: opts.openaiBaseUrl } : {}),
    });
  }
  if (effective === 'xai' || effective === 'xai-oauth') {
    // Auto-routed `xai` (model heuristic only): authMode undefined so OAuth-only
    // SuperGrok login works. Explicit `--provider xai` forces apikey;
    // `xai-oauth` (explicit or slot-routed name) forces OAuth.
    const authMode = resolveXaiConstructionAuthMode(effective, wasExplicitProvider);
    return new XaiProvider({
      permissions: { allowedTools: allowedToolsFor() },
      ...(authMode !== undefined ? { authMode } : {}),
      ...(opts?.subagentExecutor !== undefined ? { subagentExecutor: opts.subagentExecutor } : {}),
      ...(opts?.skillExecutor !== undefined ? { skillExecutor: opts.skillExecutor } : {}),
      ...(opts?.composeExecutor !== undefined ? { composeExecutor: opts.composeExecutor } : {}),
      ...(opts?.memoryStore !== undefined ? { memoryStore: opts.memoryStore } : {}),
      ...(opts?.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
    });
  }
  return undefined;
}
