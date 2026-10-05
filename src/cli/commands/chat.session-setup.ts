/**
 * Session construction helpers for `afk chat`.
 *
 * Extracted from chat.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `buildChatSession`, `ChatSessionSetupParams`, `ChatSessionSetupResult`.
 *
 * This module owns the AgentSession construction block and the executor wiring
 * that was previously inlined in registerChatCommand's action handler.
 */

import { AgentSession } from '../../agent/session.js';
import { wireExecutors } from '../../agent/session/wire-executors.js';
import { ensurePluginEntrypointsLoaded } from '../../agent/tools/skill-bridge.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { createDefaultHookRegistry } from '../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory, injectGoalPrompt } from '../../agent/memory/index.js';
import { StateStore } from '../../agent/state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { WorkspaceStore } from '../../agent/workspace/workspace-store.js';
import { env } from '../../config/env.js';
import { injectCompanionPrimer } from '../../agent/companion/index.js';
import type { AgentModelInput, ThinkingConfig, EffortLevel } from '../../agent/types.js';
import { topLevelSurfaceAllowedTools } from '../../agent/tools/top-level-allowlist.js';
import { parseProvider, getApiKeyForModel, getModel, getDefaultSubagentModel } from '../shared-helpers.js';
import type { TraceWriter } from '../../agent/trace/writer.js';
import { formatSubagentCompletion } from './interactive/progress-banner.js';
import type { McpManager } from '../../agent/mcp/index.js';
import type { PermissionMode } from '../../agent/types/sdk-types.js';
import type { ProviderRouteHints } from '../../agent/providers/index.js';

// ---------------------------------------------------------------------------
// Parameter / result shapes
// ---------------------------------------------------------------------------

export interface ChatSessionSetupParams {
  /** The model input supplied by the CLI flag (--model). */
  model: AgentModelInput;
  /** Effective session model (may differ from model if resuming with a different model). */
  sessionModel: AgentModelInput;
  /** Resolved API key for the session model. */
  apiKey: string | undefined;
  /** Assembled system prompt (base + routing directive). */
  systemPrompt: string | undefined;
  /** Provenance string for the system prompt (surfaced by --dump-prompt). */
  systemPromptSource: string | undefined;
  /** Raw base prompt before routing-directive assembly (forwarded to child sessions). */
  basePrompt: string | undefined;
  /** Provider hints from --provider flag; forwarded to getApiKeyForModel. */
  providerHints: ProviderRouteHints | undefined;
  /** Raw --provider value for parseProvider (undefined = auto-route). */
  providerRaw: string | undefined;
  thinking: ThinkingConfig | undefined;
  effort: EffortLevel | undefined;
  maxBudgetUsd: number | undefined;
  taskBudget: number | undefined;
  maxOutputTokens: number | undefined;
  maxToolUseIterations: number | undefined;
  worktreeCwd: string | undefined;
  traceWriter: TraceWriter | undefined;
  mcpManager: McpManager | undefined;
  resumeConfig: Record<string, unknown>;
  permissionMode: PermissionMode | undefined;
  dangerouslySkipPermissions: boolean | undefined;
  maxTurns: number;
  temperature: number | undefined;
  baseUrl: string | undefined;
  openaiBaseUrl: string | undefined;
  autoResumeOnUsageLimit: boolean | undefined;
}

export interface ChatSessionSetupResult {
  session: AgentSession;
  rootManager: ReturnType<typeof wireExecutors>['rootManager'];
  composeExecutor: ReturnType<typeof wireExecutors>['composeExecutor'];
  sharedMemoryStore: MemoryStore;
  sharedStateStore: StateStore;
  workspaceStore: WorkspaceStore | undefined;
}

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

/**
 * Construct the AgentSession and supporting stores for `afk chat`.
 *
 * All parameters are explicit — no closures over action-handler locals.
 * The trace writer must be opened by the caller BEFORE invoking this function
 * so the SkillExecutor and grandchild sessions inherit it correctly.
 */
export async function buildChatSession(
  params: ChatSessionSetupParams,
): Promise<ChatSessionSetupResult> {
  const {
    model,
    sessionModel,
    apiKey,
    systemPrompt,
    systemPromptSource,
    basePrompt,
    providerHints,
    providerRaw,
    thinking,
    effort,
    maxBudgetUsd,
    taskBudget,
    maxOutputTokens,
    maxToolUseIterations,
    worktreeCwd,
    traceWriter,
    mcpManager,
    resumeConfig,
    permissionMode,
    dangerouslySkipPermissions,
    maxTurns,
    temperature,
    baseUrl,
    openaiBaseUrl,
    autoResumeOnUsageLimit,
  } = params;

  const sharedMemoryStore = new MemoryStore();
  const sharedStateStore = new StateStore(getStateDatabasePath());
  let workspaceStore: WorkspaceStore | undefined;

  // Deferred parent reference so executors can be constructed before the
  // session object exists, then bound lazily.
  let boundSession: AgentSession | undefined;
  const deferredParent = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() {
      return boundSession?.abortSignal ?? new AbortController().signal;
    },
    get hookRegistry() { return boundSession?.hookRegistry; },
    get messageJournal() { return boundSession?.messageJournal; },
  };

  // Invariant: ONE root manager per session, shared by all three executors.
  // The trace writer is opened by the caller so the manager and every executor
  // inherit it — without it, skill-forked subagents emit zero trace events.
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    surface: 'cli',
    parentSession: deferredParent,
    apiKey,
    model,
    managerParentModel: getModel(),
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: getApiKeyForModel,
    ...(basePrompt !== undefined ? { systemPrompt: basePrompt } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
    ...(worktreeCwd !== undefined ? { cwd: worktreeCwd, nestedCwd: worktreeCwd } : {}),
    ...(traceWriter !== undefined
      ? { traceWriter, skillTraceWriter: traceWriter }
      : {}),
    ...(env.AFK_WORKSPACE_DISABLED !== '1' ? { workspaceStore: (workspaceStore = new WorkspaceStore()) } : {}),
  });

  const mcpToolWireNames = mcpManager?.getMcpToolWireNames() ?? [];
  const provider = parseProvider(providerRaw, {
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    memoryStore: sharedMemoryStore,
    stateStore: sharedStateStore,
    model: String(model),
    ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  })
    ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: topLevelSurfaceAllowedTools(mcpToolWireNames),
      },
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore: sharedMemoryStore,
      stateStore: sharedStateStore,
      surface: 'cli',
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    });

  await ensurePluginEntrypointsLoaded();

  const getChatPermissionMode = (): PermissionMode =>
    dangerouslySkipPermissions ? 'bypassPermissions' : (permissionMode ?? 'bypassPermissions');

  const session = new AgentSession(injectGoalPrompt(injectCompanionPrimer(injectHotMemory({
    model: sessionModel,
    surface: 'cli',
    apiKey: getApiKeyForModel(sessionModel, providerHints),
    drainSubagents: (reason) =>
      rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
    maxTurns,
    isNonInteractive: true,
    ...(dangerouslySkipPermissions
      ? { permissionMode: 'bypassPermissions' as const }
      : permissionMode !== undefined
      ? { permissionMode }
      : {}),
    hookRegistry: createDefaultHookRegistry(
      (info) => { console.log(formatSubagentCompletion(info)); },
      'cli',
      sharedMemoryStore,
      getChatPermissionMode,
      loadHooksConfig({ cwd: worktreeCwd }),
      { cwd: worktreeCwd, ...(traceWriter !== undefined ? { traceWriter } : {}) },
    ).registry,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(systemPromptSource !== undefined ? { systemPromptSource } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(taskBudget !== undefined ? { taskBudget } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(traceWriter !== undefined ? { traceWriter } : {}),
    ...(autoResumeOnUsageLimit !== undefined ? { autoResumeOnUsageLimit } : {}),
    ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
    ...resumeConfig,
    provider,
  }))), traceWriter);

  boundSession = session;

  return { session, rootManager, composeExecutor, sharedMemoryStore, sharedStateStore, workspaceStore };
}
