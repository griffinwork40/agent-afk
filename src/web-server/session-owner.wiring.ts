/**
 * Executor and infrastructure wiring for web-surface sessions.
 *
 * Extracted from {@link SessionOwner} so the owner stays under the 350-LOC
 * ceiling. Mirrors the Telegram Anthropic branch (`session-anthropic.ts`)
 * and the REPL (`bootstrap-infra.ts`): ONE root manager, three executors,
 * trace writer, MCP, background registry, and drain callback.
 *
 * Invariant: every field returned here is session-scoped. A new call per
 * `SessionOwner.create()` ensures no shared mutable state bleeds across
 * sessions the browser starts.
 */

import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { wireExecutors, type WiredExecutors } from '../agent/session/wire-executors.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { assembleSystemPrompt } from '../agent/routing-directive.js';
import { createDefaultTraceWriter, type CreatedTraceWriter } from '../agent/trace/factory.js';
import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import { McpManager, loadMcpConfig } from '../agent/mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../config/import-sources.js';
import { emitSessionPhase } from '../agent/trace/emit.js';
import { WorkspaceStore } from '../agent/workspace/index.js';
import {
  getDefaultSubagentModel,
  getApiKeyForModel,
} from '../cli/shared-helpers.js';
import { loadConfig } from '../cli/config.js';
import { MemoryStore } from '../agent/memory/index.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { AgentConfig } from '../agent/types.js';
import type { TraceWriter } from '../agent/trace/index.js';
import type { TraceSink } from '../agent/trace/writer.js';
import type { SubagentExecutorContext } from '../agent/tools/subagent-executor.js';

/** Everything `SessionOwner.create` needs beyond the base `AgentConfig`. */
export interface WebSessionWiring {
  provider: AnthropicDirectProvider;
  executors: WiredExecutors;
  traceWriter: TraceWriter | undefined;
  /** Merged system prompt (base + routing directive + end-of-turn). */
  systemPrompt: string | undefined;
  systemPromptSource: string | undefined;
  backgroundRegistry: BackgroundAgentRegistry;
  mcpManager: McpManager | undefined;
  memoryStore: MemoryStore;
  workspaceStore: WorkspaceStore;
  /** Wired into `AgentConfig.drainSubagents` to cascade-abort children on close. */
  drainSubagents: AgentConfig['drainSubagents'];
}

export interface WireWebSessionOptions {
  model: string;
  apiKey: string | undefined;
  cwd: string;
  rawPrompt: string | undefined;
  rawPromptSource: string | undefined;
}

/**
 * Build the full executor/trace/MCP/provider stack for a single web session.
 *
 * Contract: the returned `provider` must be passed into `AgentConfig` so the
 * session uses it instead of falling back to bare `resolveProvider()`.
 */
export async function wireWebSession(
  opts: WireWebSessionOptions,
): Promise<WebSessionWiring> {
  const { model, apiKey, cwd, rawPrompt, rawPromptSource } = opts;

  // -- 1. Trace writer (session-scoped UUID) ----------------------------------
  const created: CreatedTraceWriter | null = createDefaultTraceWriter();
  const traceWriter: TraceWriter | undefined = created?.writer ?? undefined;
  const traceSink: TraceSink | undefined = traceWriter;

  // -- 2. MCP servers ---------------------------------------------------------
  const mcpManager = await loadWebMcpManager(cwd, traceSink);

  // -- 3. Memory + workspace stores -------------------------------------------
  const memoryStore = new MemoryStore();
  const workspaceStore = new WorkspaceStore();

  // -- 4. Background registry -------------------------------------------------
  const backgroundRegistry = new BackgroundAgentRegistry(
    traceSink ? { traceWriter: traceSink } : {},
  );

  // -- 5. Deferred parent proxy (session constructed after executors) ----------
  let boundSession: AgentSession | undefined;
  const deferredParent: SubagentExecutorContext['parentSession'] = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() { return boundSession?.abortSignal ?? new AbortController().signal; },
    get hookRegistry() { return boundSession?.hookRegistry; },
  };

  // -- 6. wireExecutors (cwd, executors, root manager) ------------------------
  const executors = wireExecutors({
    surface: 'web',
    parentSession: deferredParent,
    apiKey,
    model,
    managerParentModel: model,
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(rawPrompt !== undefined ? { systemPrompt: rawPrompt } : {}),
    cwd,
    // Web uses uniform cwd anchoring (same as REPL, unlike Telegram).
    nestedCwd: cwd,
    ...(traceSink !== undefined ? { traceWriter: traceSink, skillTraceWriter: traceSink } : {}),
    backgroundRegistry,
    workspaceStore,
  });

  // -- 7. Provider (with executors + MCP) ------------------------------------
  const allowedTools = topLevelSurfaceAllowedTools(mcpManager?.getMcpToolWireNames() ?? []);
  const provider = new AnthropicDirectProvider({
    permissions: { allowedTools },
    subagentExecutor: executors.subagentExecutor,
    skillExecutor: executors.skillExecutor,
    composeExecutor: executors.composeExecutor,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    workspaceStore,
    surface: 'web',
  });

  // -- 8. System prompt (base + routing directive + end-of-turn) --------------
  // Web is an interactive surface like the REPL: use `interactive` auto-routing
  // and `'repl'` PromptSurface so the end-of-turn protocol is injected.
  const config = loadConfig();
  const autoRouting = config.autoRouting?.interactive ?? false;
  const systemPrompt = typeof rawPrompt === 'string'
    ? assembleSystemPrompt(rawPrompt, autoRouting, 'repl')
    : rawPrompt;

  // -- 9. Drain callback ------------------------------------------------------
  const drainSubagents: AgentConfig['drainSubagents'] = async (reason) => {
    await backgroundRegistry.cancelAll();
    return executors.rootManager.abortAllAndDrain(
      'session_end', 'user_signal', undefined, reason === 'reset',
    );
  };

  // Late-bind helper so callers can wire after session construction.
  const wiring: WebSessionWiring = {
    provider,
    executors,
    traceWriter,
    systemPrompt,
    systemPromptSource: rawPromptSource,
    backgroundRegistry,
    mcpManager,
    memoryStore,
    workspaceStore,
    drainSubagents,
  };

  // Attach the late-bind setter as a post-construction hook: the caller must
  // invoke this after `new AgentSession(config)` so the deferred proxy resolves.
  (wiring as WebSessionWiringInternal).__bindSession = (s: AgentSession) => {
    boundSession = s;
    executors.rootManager.setOnSubagentSucceeded((usage, costUsd) => {
      s.recordSubagentCompletion(usage, costUsd);
    });
    executors.composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
      s.recordSubagentCompletion(usage, costUsd);
    });
  };

  return wiring;
}

/** @internal Exposed for `SessionOwner` only. */
export interface WebSessionWiringInternal extends WebSessionWiring {
  __bindSession: (s: AgentSession) => void;
}

// ---------------------------------------------------------------------------
// MCP loader (mirrors telegram/mcp-session.ts for the web surface)
// ---------------------------------------------------------------------------

async function loadWebMcpManager(
  cwd: string,
  traceWriter?: TraceSink,
): Promise<McpManager | undefined> {
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json')
    .map((c) => c.source);
  const loaded = loadMcpConfig({
    cwd,
    ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
  });
  const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;
  if (enabledCount === 0) return undefined;

  const mcpStartedAt = Date.now();
  void emitSessionPhase(traceWriter, {
    phase: 'mcp_connect_start',
    metadata: { serverCount: enabledCount },
  });
  try {
    return await McpManager.fromConfig(loaded.mcpServers, {
      warnings: loaded.warnings,
      serverLayers: loaded.serverLayers,
      userAllowSecretEnv: loaded.userAllowSecretEnv,
      ...(traceWriter !== undefined ? { traceWriter } : {}),
    });
  } finally {
    void emitSessionPhase(traceWriter, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledCount },
    });
  }
}
