/**
 * ACP session lifecycle helpers.
 *
 * Owns AgentSession construction and teardown for the ACP server.
 * Extracted from acp.server.ts to stay under the 200-line function ceiling.
 *
 * @module cli/commands/acp.session
 */

import { AgentSession } from '../../agent/session.js';
import { managerShutdownConfig } from '../../agent/session/manager-shutdown-config.js';
import { wireExecutors } from '../../agent/session/wire-executors.js';
import { ensurePluginEntrypointsLoaded } from '../../agent/tools/skill-bridge.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { createDefaultHookRegistry } from '../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory } from '../../agent/memory/index.js';
import { StateStore } from '../../agent/state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { topLevelSurfaceAllowedTools } from '../../agent/tools/top-level-allowlist.js';
import { getApiKeyForModel, getModel, getDefaultSubagentModel } from '../shared-helpers.js';
import type { AgentModelInput } from '../../agent/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcpSessionOptions {
  model: AgentModelInput;
  maxTurns: number;
}

/** Opaque handle returned by buildAcpSession and accepted by closeAcpSession. */
export interface AcpSessionHandle {
  session: AgentSession;
  memoryStore: MemoryStore;
  stateStore: StateStore;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Construct an AgentSession for the ACP server.
 *
 * Uses bypassPermissions (the ACP surface has no interactive approval flow)
 * and the CLI surface label so existing tool-allowlist logic applies.
 */
export async function buildAcpSession(opts: AcpSessionOptions): Promise<AcpSessionHandle> {
  const { model, maxTurns } = opts;
  const memoryStore = new MemoryStore();
  const stateStore = new StateStore(getStateDatabasePath());

  let boundSession: AgentSession | undefined;
  const deferredParent = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() {
      return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} };
    },
    get abortSignal() {
      return boundSession?.abortSignal ?? new AbortController().signal;
    },
    get hookRegistry() { return boundSession?.hookRegistry; },
    get messageJournal() { return boundSession?.messageJournal; },
  };

  const apiKey = getApiKeyForModel(model);
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    surface: 'cli',
    parentSession: deferredParent,
    apiKey,
    model,
    managerParentModel: getModel(),
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: getApiKeyForModel,
  });

  const provider = new AnthropicDirectProvider({
    permissions: { allowedTools: topLevelSurfaceAllowedTools([]) },
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    memoryStore,
    stateStore,
    surface: 'cli',
  });

  await ensurePluginEntrypointsLoaded();

  const session = new AgentSession(
    injectHotMemory({
      model,
      surface: 'cli',
      apiKey,
      ...managerShutdownConfig(rootManager, composeExecutor),
      maxTurns,
      isNonInteractive: true,
      permissionMode: 'bypassPermissions',
      hookRegistry: createDefaultHookRegistry(
        () => {},
        'cli',
        memoryStore,
        () => 'bypassPermissions',
        loadHooksConfig({}),
        {},
      ).registry,
      provider,
    }),
    undefined,
  );

  boundSession = session;
  return { session, memoryStore, stateStore };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Close an ACP session handle and release its resources. */
export async function closeAcpSession(handle: AcpSessionHandle): Promise<void> {
  try {
    await handle.session.close();
  } finally {
    try { handle.memoryStore.close(); } catch { /* best-effort */ }
    try { handle.stateStore.close(); } catch { /* best-effort */ }
  }
}
