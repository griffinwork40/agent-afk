/** ACP session composition and resource ownership. */
import { AgentSession } from '../../agent/session.js';
import { makeDeferredParentProxy } from '../../agent/session/deferred-parent-proxy.js';
import { managerShutdownConfig } from '../../agent/session/manager-shutdown-config.js';
import { withContinuationDispose } from '../../agent/subagent/continuation-dispose.js';
import { wireExecutors } from '../../agent/session/wire-executors.js';
import { ensurePluginEntrypointsLoaded } from '../../agent/tools/skill-bridge.js';
import { createDefaultHookRegistry } from '../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory, injectEpisodeRecall } from '../../agent/memory/index.js';
import { StateStore } from '../../agent/state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { createDefaultTraceWriter } from '../../agent/trace/factory.js';
import { getApiKeyForModel, getModel, getDefaultSubagentModel } from '../shared-helpers.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { AgentConfig } from '../../agent/types/config-types.js';
import type { CanUseTool } from './acp.wire.js';
import type { ChildCanUseToolFactory } from '../../agent/tools/nesting.can-use-tool.js';
import { connectAcpMcp } from './acp.session.mcp.js';
import { resolveAcpPrompt } from './acp.session.prompt.js';
import { createAcpProvider } from './acp.session.provider.js';
import { AcpSessionResources, onceAcpShutdown } from './acp.session.resources.js';

export interface AcpSessionOptions {
  model: AgentModelInput;
  maxTurns: number;
  /** D8: skip the approval bridge only. Every ACP session runs in bypassPermissions. */
  dangerouslySkipPermissions?: boolean;
  cwd?: string;
  /** Inject into the provider, not AgentConfig, because this provider is prebuilt. */
  canUseTool?: CanUseTool;
  /** D9: per-child approval callback factory, passed to executor wiring. */
  childCanUseTool?: ChildCanUseToolFactory;
  resume?: string;
  sessionId?: string;
  /** Already converted from the wire stdio array to AFK's name-keyed config. */
  mcpServers?: AgentConfig['mcpServers'];
}

export interface AcpSessionHandle {
  session: AgentSession;
  memoryStore: MemoryStore;
  stateStore: StateStore;
  /** Optional for backward-compatible handles created by embedders/test doubles. */
  resources?: AcpSessionResources;
}

export async function buildAcpSession(opts: AcpSessionOptions): Promise<AcpSessionHandle> {
  const { model, maxTurns } = opts;
  const permissionMode = 'bypassPermissions' as const;
  const cwd = opts.cwd ?? process.cwd();
  const resources = new AcpSessionResources();
  try {
    const traceWriter = createDefaultTraceWriter()?.writer;
    if (traceWriter !== undefined) resources.add(() => traceWriter.close());
    const memoryStore = new MemoryStore();
    resources.add(() => memoryStore.close());
    const stateStore = new StateStore(getStateDatabasePath());
    resources.add(() => stateStore.close());
    const { basePrompt, operatorOverlay, systemPrompt, systemPromptSource } = resolveAcpPrompt(cwd);
    const mcpManager = await connectAcpMcp(cwd, opts.mcpServers, traceWriter);
    if (mcpManager !== undefined) resources.add(() => mcpManager.disconnectAll());
    const { proxy: deferredParent, bind: bindParent } = makeDeferredParentProxy();
    const apiKey = getApiKeyForModel(model);
    const { rootManager, subagentExecutor, skillExecutor, composeExecutor, continuationRegistry } = wireExecutors({
      surface: 'cli',
      parentSession: deferredParent,
      apiKey,
      model,
      managerParentModel: getModel(),
      defaultSubagentModel: getDefaultSubagentModel(model),
      resolveApiKeyForModel: getApiKeyForModel,
      cwd,
      nestedCwd: cwd,
      ...(basePrompt !== undefined ? { systemPrompt: basePrompt } : {}),
      ...(operatorOverlay !== undefined ? { operatorOverlay } : {}),
      ...(traceWriter !== undefined ? { traceWriter, skillTraceWriter: traceWriter } : {}),
      ...(opts.childCanUseTool !== undefined ? { childCanUseTool: opts.childCanUseTool } : {}),
      // No backgroundRegistry: ACP lists "No background subagents" as a surface
      // limit (website/content/docs/surfaces/acp.mdx:264); background dispatch
      // is omitted intentionally, not accidentally.
    });
    const shutdown = withContinuationDispose(managerShutdownConfig(rootManager, composeExecutor), continuationRegistry);
    const drainSubagents = onceAcpShutdown(shutdown.drainSubagents);
    // Invariant: drainSubagents is called twice on a normal close: once by
    // session.close() (which calls it internally via AgentSession) and once
    // through this disposer when resources.release() runs. The double-call is
    // safe only because onceAcpShutdown makes drainSubagents idempotent: the
    // second call returns the same promise as the first without re-running the
    // drain. Do not replace onceAcpShutdown with a plain async wrapper here
    // without also removing one of the two call sites.
    resources.add(() => drainSubagents('close'));
    const provider = createAcpProvider({
      model: String(model), subagentExecutor, skillExecutor, composeExecutor, memoryStore, stateStore,
      ...(mcpManager !== undefined ? { mcpManager } : {}),
      ...(opts.canUseTool !== undefined ? { canUseTool: opts.canUseTool } : {}),
    });
    // AgentSession closes the query; the surface also owns the provider's stores.
    resources.add(() => provider.close?.());
    await ensurePluginEntrypointsLoaded();

    // Companion/goal injection remains intentionally omitted: those carry
    // additional state dependencies unrelated to ACP (see issue #4725).
    const session = new AgentSession(
      injectEpisodeRecall(injectHotMemory({
        model,
        surface: 'cli',
        apiKey,
        ...shutdown,
        drainSubagents,
        maxTurns,
        isNonInteractive: true,
        permissionMode,
        hookRegistry: createDefaultHookRegistry(
          () => {},
          'cli',
          memoryStore,
          () => permissionMode,
          loadHooksConfig({ cwd }),
          // Project shell hooks run in the client's session directory, not the
          // directory the server was launched from (config-bridge falls back to
          // process.cwd() when cwd is absent).
          {
            cwd,
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(traceWriter !== undefined ? { traceWriter } : {}),
          },
        ).registry,
        provider,
        cwd,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        systemPromptSource,
        ...(traceWriter !== undefined ? { traceWriter } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      }), undefined, cwd, memoryStore),
      traceWriter,
    );
    bindParent(session);
    return { session, memoryStore, stateStore, resources };
  } catch (error) {
    await resources.release();
    throw error;
  }
}

/** Session close drains children/seals the trace; release external owners last. */
export async function closeAcpSession(handle: AcpSessionHandle): Promise<void> {
  try {
    await handle.session.close();
  } finally {
    if (handle.resources !== undefined) await handle.resources.release();
    else {
      try { handle.memoryStore.close(); } catch { /* best-effort legacy handle */ }
      try { handle.stateStore.close(); } catch { /* best-effort legacy handle */ }
    }
  }
}
