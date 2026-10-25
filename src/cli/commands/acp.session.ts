/**
 * ACP session lifecycle helpers.
 *
 * Owns AgentSession construction and teardown for the ACP server.
 * Extracted from acp.server.ts to stay under the 200-line function ceiling.
 *
 * @module cli/commands/acp.session
 */

import { AgentSession } from '../../agent/session.js';
import { makeDeferredParentProxy } from '../../agent/session/deferred-parent-proxy.js';
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
  /** When true, sessions run in bypassPermissions mode (fix #1). */
  dangerouslySkipPermissions?: boolean;
  /** Optional working directory for the session (non-blocking extra). */
  cwd?: string;
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
 * Fix #1: Default permissionMode is 'default'. Only 'bypassPermissions' when
 * dangerouslySkipPermissions is explicitly true.
 */
export async function buildAcpSession(opts: AcpSessionOptions): Promise<AcpSessionHandle> {
  const { model, maxTurns } = opts;
  // Fix #1: use 'default' unless the flag is explicitly set
  const permissionMode = opts.dangerouslySkipPermissions ? 'bypassPermissions' : 'default';

  const memoryStore = new MemoryStore();
  const stateStore = new StateStore(getStateDatabasePath());

  const { proxy: deferredParent, bind: bindParent } = makeDeferredParentProxy();

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
      permissionMode,
      hookRegistry: createDefaultHookRegistry(
        () => {},
        'cli',
        memoryStore,
        () => permissionMode,
        loadHooksConfig({}),
        {},
      ).registry,
      provider,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }),
    undefined,
  );

  bindParent(session);
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
