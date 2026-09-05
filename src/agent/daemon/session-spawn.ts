import { randomUUID } from 'node:crypto';

import { env } from '../../config/env.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import { getStateDatabasePath } from '../../paths.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';
import { MemoryStore, injectHotMemory } from '../memory/index.js';
import { McpManager, loadMcpConfig } from '../mcp/index.js';
import { injectCompanionPrimer } from '../companion/index.js';
import { AgentSession } from '../session/agent-session.js';
import { registerSurfaceSession } from '../session/register-surface-session.js';
import { loadHooksConfig } from '../hooks/config-loader.js';
import { StateStore } from '../state/state-store.js';
import { emitSessionPhase } from '../trace/emit.js';
import { createDefaultTraceWriter } from '../trace/factory.js';
import type { TraceWriter } from '../trace/index.js';
import type { AgentConfig } from '../types.js';

export interface DaemonSpawnOptions {
  sessionConfig?: Partial<AgentConfig>;
  sessionFactory?: (config: AgentConfig, ownedTraceWriter?: TraceWriter) => AgentSession;
  /** Propagated from the scheduler so pull-mode tasks keep ask_question. */
  trigger?: 'cron' | 'sessionstart' | 'pull';
}

/**
 * Build a charset-safe witness `sessionLabel` for a daemon tick, shaped
 * `<sanitized-taskId>-<uuid>` so traces are greppable by task name yet each
 * tick still gets its own trace dir (a bare taskId would make repeated ticks
 * append to one ever-growing file — the factory treats a repeated label as
 * resume/append).
 *
 * Contract: the result always satisfies SESSION_ID_SAFE (/^[a-zA-Z0-9_-]+$/)
 * because getTraceDir() validates the label and throws otherwise, and a raw
 * taskId may legally contain '.', '/', or spaces.
 */
export function daemonTraceLabel(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'task'}-${randomUUID()}`;
}

export async function spawnDaemonSession(taskId: string, options: DaemonSpawnOptions): Promise<{
  session: AgentSession;
  memoryStore: MemoryStore;
  stateStore: StateStore;
  mcpManager?: McpManager;
  /** Archive the cross-surface registry handle. Called by runOnce on close. */
  dispose: () => void;
}> {
  // Derive a unique-per-tick sessionId (daemonTraceLabel appends a random
  // suffix, so each tick gets its own label) so hook commands receive a
  // non-empty AFK_SESSION_ID and traces stay greppable by task name.
  const sessionId = daemonTraceLabel(taskId);
  const agentCwd = options.sessionConfig?.cwd ?? process.cwd();
  // Witness layer: open a fresh trace per spawned daemon session so its
  // subagent + skill lifecycle events are durable on disk — the AFK
  // (away-from-keyboard) surface where post-hoc inspection matters most.
  // Mirrors chat.ts / interactive bootstrap.ts. Returns null under
  // AFK_TRACE_DISABLED=1. The label is derived from the taskId (see
  // daemonTraceLabel) so traces are greppable by task name while each tick
  // still gets its own trace dir. Created before the hook registry so the
  // AFK gate's structured audit trace is wired from the start of the session.
  const trace = createDefaultTraceWriter({ sessionLabel: sessionId });
  const { registry, memoryStore } = createDefaultHookRegistry(
    undefined,
    'daemon',
    undefined,
    undefined,
    loadHooksConfig({ cwd: agentCwd }),
    { cwd: agentCwd, sessionId, ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}) },
  );
  const stateStore = new StateStore(getStateDatabasePath());

  let mcpManager: McpManager | undefined;
  // Mirror the chat / telegram / interactive surfaces: include MCP configs
  // contributed by imported roots so the daemon reaches the same MCP
  // surface-parity, not just cwd `.mcp.json` + the global config.
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json')
    .map((c) => c.source);
  const loadedMcp = loadMcpConfig({
    cwd: agentCwd,
    ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
  });
  const enabledMcpCount = Object.values(loadedMcp.mcpServers).filter((s) => !s.disabled).length;
  try {
    if (enabledMcpCount > 0) {
      // Witness layer: bracket the whole-fleet MCP connect with
      // mcp_connect_start / mcp_connect_done phases — surface-parity with
      // chat.ts, interactive/bootstrap.ts, and telegram/mcp-session.ts.
      // try/finally so mcp_connect_done fires even when an alwaysLoad server
      // makes fromConfig throw. Fire-and-forget; never gates the connect.
      const mcpStartedAt = Date.now();
      void emitSessionPhase(trace?.writer, {
        phase: 'mcp_connect_start',
        metadata: { serverCount: enabledMcpCount },
      });
      try {
        mcpManager = await McpManager.fromConfig(loadedMcp.mcpServers, {
          warnings: loadedMcp.warnings,
          serverLayers: loadedMcp.serverLayers,
          userAllowSecretEnv: loadedMcp.userAllowSecretEnv,
          ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
        });
      } finally {
        void emitSessionPhase(trace?.writer, {
          phase: 'mcp_connect_done',
          durationMs: Date.now() - mcpStartedAt,
          metadata: { serverCount: enabledMcpCount },
        });
      }
    } else if (loadedMcp.warnings.length > 0) {
      for (const warning of loadedMcp.warnings) console.warn(`[mcp] ${warning}`);
    }
  } catch (err) {
    // McpManager.fromConfig re-throws when an `alwaysLoad` server fails to
    // connect. runOnce()'s finally cannot close this tick's MemoryStore
    // (its local is still null until spawnSession returns), so close it here
    // to avoid orphaning the SQLite handle on a connect failure.
    memoryStore.close();
    stateStore.close();
    throw err;
  }

  // Opt-in top-level tool-use-round ceiling (AFK_MAX_TOOL_USE_ITERATIONS).
  // Parsed inline from the already-imported `env` rather than via the CLI
  // `getMaxToolUseIterations()` helper to avoid an agent→cli layering
  // dependency (scheduler lives in src/agent/). Mirrors the lenient contract
  // of `parseMaxToolUseIterations` in cli/shared-helpers.ts: unset/non-numeric/
  // <=0 → undefined = unlimited (no behavior change); positive → floored int.
  // Placed BEFORE the `...sessionConfig` spread so an explicit
  // sessionConfig.maxToolUseIterations still wins (escape-hatch parity with
  // permissionMode/surface). The production path also re-applies the same
  // env fallback in the daemon.ts factory; both resolve to the same value.
  const rawMaxToolIters = env.AFK_MAX_TOOL_USE_ITERATIONS;
  const parsedMaxToolIters =
    rawMaxToolIters !== undefined && Number.isFinite(Number(rawMaxToolIters)) && Number(rawMaxToolIters) > 0
      ? Math.floor(Number(rawMaxToolIters))
      : undefined;
  const config: AgentConfig = {
    model: 'sonnet',
    // Daemon-spawned sessions run autonomously and require tool use without
    // human confirmation. Explicitly set bypassPermissions so the default
    // flip in C2 (from 'bypassPermissions' to 'default') does not silently
    // break scheduled tasks that depend on tool execution.
    permissionMode: 'bypassPermissions',
    hookRegistry: registry,
    // Pull tasks keep ask_question (handoff handler persists the question
    // for eventual reply); cron/sessionstart tasks strip it.
    isNonInteractive: options.trigger !== 'pull',
    // Surface stamps the session as 'daemon' so routing-decision telemetry
    // rows derive origin:'daemon' correctly. Placed before sessionConfig so
    // an operator escape-hatch via sessionConfig.surface can still override.
    // The production factory path (daemon.ts ComposeExecutor / SubagentExecutor
    // wiring) already stamps surface:'daemon' on its executors; this covers
    // the fallback/standalone path where no factory is set.
    surface: 'daemon',
    // Trace writer placed before sessionConfig so an operator-supplied
    // sessionConfig.traceWriter still wins (escape-hatch parity with
    // permissionMode).
    ...(trace ? { traceWriter: trace.writer } : {}),
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    // Opt-in top-level tool-round ceiling default; overridable by an explicit
    // sessionConfig.maxToolUseIterations via the spread below.
    ...(parsedMaxToolIters !== undefined ? { maxToolUseIterations: parsedMaxToolIters } : {}),
    // sessionConfig may override permissionMode if the operator explicitly
    // wants a different mode for daemon tasks (intentional escape hatch).
    ...options.sessionConfig,
  };
  try {
    const traceOwner = options.sessionConfig?.traceWriter === undefined ? trace?.writer : undefined;
    const session = options.sessionFactory
      ? options.sessionFactory(config, traceOwner)
      : new AgentSession(injectCompanionPrimer(injectHotMemory(config)), traceOwner);
    // Step 7: register the daemon session in the cross-surface registry.
    // Best-effort; dispose() (archive) is invoked by runOnce on session close
    // so the long-running daemon never accumulates registry handles.
    const registration = registerSurfaceSession(session, {
      surface: 'daemon',
      model: config.model,
      cwd: agentCwd,
    });
    return {
      session,
      memoryStore,
      stateStore,
      dispose: registration.dispose,
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    };
  } catch (err) {
    if (mcpManager) {
      await mcpManager.disconnectAll().catch(() => undefined);
    }
    // Session construction failed after MCP connected — close this tick's
    // MemoryStore and StateStore too (runOnce()'s finally can't, per the
    // fromConfig catch above) so they are not orphaned.
    memoryStore.close();
    stateStore.close();
    throw err;
  }
}
