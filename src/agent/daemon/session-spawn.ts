import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { env } from '../../config/env.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import { getStateDatabasePath, getDaemonStateDir } from '../../paths.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';
import { MemoryStore, injectHotMemory, injectGoalPrompt } from '../memory/index.js';
import { McpManager, loadMcpConfig } from '../mcp/index.js';
import { injectCompanionPrimer } from '../companion/index.js';
import { AgentSession } from '../session/agent-session.js';
import { registerSurfaceSession } from '../session/register-surface-session.js';
import { loadHooksConfig } from '../hooks/config-loader.js';
import { StateStore } from '../state/state-store.js';
import { emitSessionPhase } from '../trace/emit.js';
import { createDefaultTraceWriter } from '../trace/factory.js';
import type { TraceSink, TraceWriter } from '../trace/index.js';
import type { TraceEventInput } from '../trace/types.js';
import type { AgentConfig } from '../types.js';

export interface DaemonSpawnOptions {
  sessionConfig?: Partial<AgentConfig>;
  sessionFactory?: (config: AgentConfig, ownedTraceWriter?: TraceWriter) => AgentSession;
  /** Propagated from the scheduler so pull-mode tasks keep ask_question. */
  trigger?: 'cron' | 'sessionstart' | 'pull';
  /**
   * Per-task working directory. Takes precedence over `sessionConfig.cwd`
   * (daemon-wide AFK_DAEMON_CWD). Precedence: taskCwd ?? sessionConfig.cwd ?? daemonDefaultCwd().
   */
  taskCwd?: string;
  /**
   * Shared mutable counter incremented each time the AFK gate emits a
   * `hook_decision` with `approvalOutcome: 'hard-block'` during this tick
   * (#3466). The spawn wires a counting shim around the trace writer so the
   * caller can read the total after `sendMessage` resolves and record it on
   * the telemetry record without polling the trace file.
   */
  gateBlockCounter?: { count: number };
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

/**
 * Last-resort cwd for daemon sessions when neither per-task `cwd` nor the
 * daemon-wide `AFK_DAEMON_CWD` is configured.
 *
 * Returns the daemon state directory (`~/.afk/state/daemon/agent-afk@default/`)
 * and creates it if it does not yet exist. This is a small, project-neutral
 * directory — not `$HOME` — so unscoped glob/grep calls made by the agent do
 * not walk the whole home directory.
 *
 * Callers that have an explicit cwd (task.cwd or sessionConfig.cwd) never reach
 * this function, so the precedence `task.cwd ?? AFK_DAEMON_CWD ?? daemonDefaultCwd()`
 * is preserved.
 */
// Contract: daemonDefaultCwd() never throws. On EACCES/ENOSPC it falls back to
// os.tmpdir() so every scheduler tick has a valid cwd even when the daemon
// state directory cannot be created (e.g. permission denied after a system
// misconfiguration or a full disk). The caller that has an explicit cwd
// (task.cwd or sessionConfig.cwd) never reaches this function.

/**
 * Memoized result of the first daemonDefaultCwd() call (success or fallback).
 *
 * Contract: once set, this value is returned for every subsequent call without
 * re-running mkdirSync or re-emitting the warning. The cached path is NOT
 * re-verified for liveness — a directory that is later removed or unmounted is
 * still returned. This is intentional: the daemon state dir is owned by the
 * process and re-checking every tick would add I/O overhead with no recovery
 * path (the scheduler has no mechanism to quarantine a single tick on cwd
 * failure). Call `_resetDaemonDefaultCwdCache()` in tests that swap AFK_HOME.
 */
let _daemonDefaultCwdCache: string | null = null;

/**
 * Reset the memoized cwd cache. Exposed for tests that change AFK_HOME between
 * cases — production code never calls this.
 */
export function _resetDaemonDefaultCwdCache(): void {
  _daemonDefaultCwdCache = null;
}

export function daemonDefaultCwd(): string {
  if (_daemonDefaultCwdCache !== null) return _daemonDefaultCwdCache;
  const dir = getDaemonStateDir();
  try {
    mkdirSync(dir, { recursive: true });
    _daemonDefaultCwdCache = dir;
    return dir;
  } catch (err) {
    const fallback = tmpdir();
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    console.warn(
      `[daemon] daemonDefaultCwd: could not create ${dir} (${code}); ` +
        `falling back to ${fallback}. ` +
        `To fix: correct permissions on ${dir} or set AFK_STATE_DIR (or AFK_HOME) to a writable path.`,
    );
    // Memoize the fallback too so the warning fires only once per process even
    // if mkdirSync keeps throwing (e.g. EACCES on every scheduler tick).
    _daemonDefaultCwdCache = fallback;
    return fallback;
  }
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
  // Precedence: per-task cwd ?? daemon-wide sessionConfig.cwd ?? daemonDefaultCwd().
  // The daemon state dir (~/.afk/state/daemon/agent-afk@default/) is used as the
  // last-resort fallback instead of process.cwd(). When installed as a service,
  // process.cwd() is $HOME, which causes unscoped glob/grep to walk the whole home
  // directory (~1.5 M entries). The daemon state dir is a small, project-neutral
  // directory that already exists (the daemon creates it on startup). Users who
  // explicitly set task.cwd or AFK_DAEMON_CWD are unaffected — those values win.
  const agentCwd = options.taskCwd ?? options.sessionConfig?.cwd ?? daemonDefaultCwd();
  // Witness layer: open a fresh trace per spawned daemon session so its
  // subagent + skill lifecycle events are durable on disk — the AFK
  // (away-from-keyboard) surface where post-hoc inspection matters most.
  // Mirrors chat.ts / interactive bootstrap.ts. Returns null under
  // AFK_TRACE_DISABLED=1. The label is derived from the taskId (see
  // daemonTraceLabel) so traces are greppable by task name while each tick
  // still gets its own trace dir. Created before the hook registry so the
  // AFK gate's structured audit trace is wired from the start of the session.
  const trace = createDefaultTraceWriter({ sessionLabel: sessionId });
  // Contract: when a gateBlockCounter is supplied, wrap the trace writer with a
  // counting shim BEFORE wiring it into createDefaultHookRegistry so the AFK
  // gate's emitHookDecision calls go through the shim. The shim delegates every
  // write() to the real writer — it is purely observational — and increments
  // the counter each time it sees a hook_decision with approvalOutcome:
  // 'hard-block'. This lets executeAgentTask read the final count after
  // sendMessage() returns and set status:'blocked' without polling the trace file.
  const hookTraceWriter = makeGateBlockTraceWriter(trace?.writer, options.gateBlockCounter);
  const { registry, memoryStore } = createDefaultHookRegistry(
    undefined,
    'daemon',
    undefined,
    // Always pass a mode getter so createAfkModeGate registers. Daemon ticks
    // run autonomously by definition — pass 'autonomous' unconditionally.
    // Because no elicitation handler is installed on this surface, high-risk
    // ops degrade to the hard-block path (the gate's "no operator reachable"
    // degrade). promptForApproval: false enforces this; it mirrors the Telegram
    // posture (always-on, no deliberate human arming). See afk-mode-gate.ts.
    (): 'autonomous' => 'autonomous',
    loadHooksConfig({ cwd: agentCwd }),
    {
      cwd: agentCwd,
      sessionId,
      ...(hookTraceWriter !== undefined ? { traceWriter: hookTraceWriter } : {}),
      // Hard-block posture: no operator is reachable on a daemon tick.
      // High-risk ops are refused immediately rather than queued for approval.
      afkPromptForApproval: false,
      // Issue #3464: supply the running task's own id so the risk classifier
      // can carve out self-disable (cancel_schedule / update_schedule with
      // enabled:false) as 'medium'. This value comes from the scheduler, not
      // from any model-supplied input — it cannot be spoofed by the agent.
      daemonTaskId: taskId,
    },
  );
  const stateStore = new StateStore(getStateDatabasePath());

  let mcpManager: McpManager | undefined;
  try {
    mcpManager = await connectDaemonMcp(agentCwd, trace?.writer);
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
    // Per-task cwd wins over sessionConfig.cwd (daemon-wide AFK_DAEMON_CWD).
    // Placed AFTER the sessionConfig spread so the task-level value is never
    // overwritten by the daemon-wide one. agentCwd already encodes the correct
    // precedence (taskCwd ?? sessionConfig.cwd ?? daemonDefaultCwd()).
    cwd: agentCwd,
  };
  try {
    const traceOwner = options.sessionConfig?.traceWriter === undefined ? trace?.writer : undefined;
    const session = options.sessionFactory
      ? options.sessionFactory(config, traceOwner)
      : new AgentSession(injectGoalPrompt(injectCompanionPrimer(injectHotMemory(config))), traceOwner);
    // Wire session-layer Stop dispatch for the daemon surface. Daemon/cron tasks
    // are one-shot: there is no next user turn for injectContext delivery.
    // `getHasNextTurn: () => false` causes the session layer to drop injectContext
    // and emit a `stop_inject_dropped` trace event instead.
    //
    // The terminal-state gate is NOT registered here: it only returns
    // injectContext, which a one-shot tick always drops. It joins the daemon
    // with same-turn continuation (PR 2); `daemon.verifyDone` still relabels
    // an unbacked Done in the push. Shell hooks run only with enableShellHooks.
    session.wireStopHook?.({ getHasNextTurn: () => false });
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

/**
 * Load MCP config from disk and connect all enabled servers for a daemon tick.
 *
 * Extracted from `spawnDaemonSession` to keep that function within the 200-line
 * ceiling. Mirrors the connect block in `chat.ts`, `interactive/bootstrap.ts`,
 * and `telegram/mcp-session.ts`. Returns `undefined` when no servers are enabled.
 *
 * Throws when an `alwaysLoad` server fails — callers are responsible for closing
 * any already-opened stores before propagating the error.
 */
async function connectDaemonMcp(
  agentCwd: string,
  traceWriter: TraceSink | undefined,
): Promise<McpManager | undefined> {
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
  if (enabledMcpCount === 0) {
    if (loadedMcp.warnings.length > 0) {
      for (const warning of loadedMcp.warnings) console.warn(`[mcp] ${warning}`);
    }
    return undefined;
  }
  // Witness layer: bracket the whole-fleet MCP connect with
  // mcp_connect_start / mcp_connect_done phases — surface-parity with
  // chat.ts, interactive/bootstrap.ts, and telegram/mcp-session.ts.
  // try/finally so mcp_connect_done fires even when an alwaysLoad server
  // makes fromConfig throw. Fire-and-forget; never gates the connect.
  const mcpStartedAt = Date.now();
  void emitSessionPhase(traceWriter, {
    phase: 'mcp_connect_start',
    metadata: { serverCount: enabledMcpCount },
  });
  try {
    return await McpManager.fromConfig(loadedMcp.mcpServers, {
      warnings: loadedMcp.warnings,
      serverLayers: loadedMcp.serverLayers,
      userAllowSecretEnv: loadedMcp.userAllowSecretEnv,
      ...(traceWriter !== undefined ? { traceWriter } : {}),
    });
  } finally {
    void emitSessionPhase(traceWriter, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledMcpCount },
    });
  }
}

/**
 * Wrap a real {@link TraceSink} with a shim that increments `counter.count`
 * each time the AFK gate emits a `hook_decision` with
 * `approvalOutcome: 'hard-block'` (#3466).
 *
 * Returns `undefined` when either `inner` or `counter` is absent — callers
 * spread the result with `?? undefined` so the hook registry falls back to
 * its normal no-writer path. The shim is purely observational: every `write()`
 * call is delegated to the real writer unconditionally, even on hard-block
 * events, so the trace file is unaffected.
 */
function makeGateBlockTraceWriter(
  inner: TraceSink | undefined,
  counter: { count: number } | undefined,
): TraceSink | undefined {
  if (inner === undefined || counter === undefined) return inner;
  return {
    getTracePath(): string {
      return inner.getTracePath();
    },
    write(event: TraceEventInput): Promise<void> {
      if (
        event.kind === 'hook_decision' &&
        (event.payload as { approvalOutcome?: string }).approvalOutcome === 'hard-block'
      ) {
        counter.count += 1;
      }
      return inner.write(event);
    },
  };
}
