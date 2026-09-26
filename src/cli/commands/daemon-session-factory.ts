import { env } from '../../config/env.js';
import { getApiKeyForModel, getDefaultSubagentModel, getMaxToolUseIterations, parseProvider } from '../shared-helpers.js';
import type { AgentConfig, AgentModelInput } from '../../agent/types.js';
import { AgentSession } from '../../agent/session.js';
import { MemoryStore, MEMORY_TOOL_NAMES, injectHotMemory, injectGoalPrompt } from '../../agent/memory/index.js';
import { StateStore } from '../../agent/state/state-store.js';
import { STATE_TOOL_NAMES } from '../../agent/state/state-tools.js';
import { getStateDatabasePath } from '../../paths.js';
import { WORKSPACE_TOOL_NAMES } from '../../agent/workspace/index.js';
import { injectCompanionPrimer } from '../../agent/companion/index.js';
import { wireExecutors } from '../../agent/session/wire-executors.js';
import { createStubParentSession } from '../../agent/tools/nesting.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { BUILTIN_TOOL_NAMES } from '../../agent/tools/schemas.js';
import { AWARENESS_TOOL_NAMES } from '../../agent/awareness/index.js';
import { WorkspaceStore } from '../../agent/workspace/workspace-store.js';

/**
 * Options for {@link buildDaemonSessionFactory}.
 */
export interface BuildDaemonSessionFactoryOpts {
  model: AgentModelInput;
  apiKey?: string;
  baseUrl?: string;
  openaiBaseUrl?: string;
  cwd?: string;
}

/**
 * Build the fully-wired session factory daemon tasks need so that
 * skill-dispatching commands like `/forge-friction --auto` or `/review pr 123`
 * can call the `skill`, `agent`, and `compose` tools.
 *
 * The executor trio (and the single root SubagentManager they share) comes from
 * `wireExecutors()`; `parseProvider()` then builds the root provider around
 * them, falling back to AnthropicDirectProvider for Anthropic-routed models.
 *
 * The returned factory receives a config that spawnSession() has already
 * populated (including permissionMode:'bypassPermissions'). The config is
 * preserved via spread so no caller-set field is lost.
 */
export function buildDaemonSessionFactory(
  opts: BuildDaemonSessionFactoryOpts,
): (config: AgentConfig, ownedTraceWriter?: import('../../agent/trace/index.js').TraceWriter) => AgentSession {
  // Invariant: exactly one MemoryStore per daemon process. The constructor
  // opens a SQLite handle synchronously (see memory-store.ts), so building a
  // fresh store inside the per-task closure would leak one file descriptor on
  // every cron tick for the daemon's (long) lifetime AND violate the
  // single-instance-per-DB-file rule chat.ts documents as the "C7 fix". We
  // lazily create the store on the first task spawn and reuse it across every
  // task session, which also gives cross-task memory continuity for free. The
  // store is intentionally not closed here: the daemon owns it for its whole
  // process lifetime and the SIGINT/SIGTERM shutdown path ends in
  // process.exit(), which reclaims the descriptor.
  //
  // WorkspaceStore is intentionally NOT shared across tasks: one task's
  // published entries are irrelevant to the next task's compose nodes, and
  // reusing the store would inject stale workspace entries from a prior
  // task's run. Create a fresh store per task invocation instead.
  let memoryStore: MemoryStore | undefined;
  let stateStore: StateStore | undefined;
  return (config: AgentConfig, ownedTraceWriter?: import('../../agent/trace/index.js').TraceWriter): AgentSession => {
    // Ephemeral abort controller — the daemon root session has no parent
    // to propagate cancellation from.
    const abortCtrl = new AbortController();
    const stubParent = createStubParentSession(abortCtrl.signal);

    // Invariant: ONE root manager per session, shared by all three executors.
    // The scheduler (scheduler.ts:spawnSession) already opened a per-tick trace
    // and threaded it in as config.traceWriter — reuse THAT SAME instance here
    // rather than creating a duplicate. Undefined under AFK_TRACE_DISABLED=1,
    // in which case the option is absent and behaviour is unchanged.
    memoryStore ??= new MemoryStore();
    stateStore ??= new StateStore(getStateDatabasePath());
    // WorkspaceStore is fresh per task: one task's published entries are
    // irrelevant to the next task's compose nodes, and reusing the store
    // would inject stale workspace entries from a prior task's run.
    // Skipped when workspace is disabled (AFK_WORKSPACE_DISABLED=1).
    const workspaceStore = env.AFK_WORKSPACE_DISABLED === '1' ? undefined : new WorkspaceStore();
    const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
      surface: 'daemon',
      parentSession: stubParent,
      apiKey: opts.apiKey,
      model: opts.model,
      // The daemon resolves its credential from the task model itself, so the
      // manager's credential-fallback anchor is the same model.
      managerParentModel: opts.model,
      defaultSubagentModel: getDefaultSubagentModel(opts.model),
      resolveApiKeyForModel: getApiKeyForModel,
      // Daemon tasks carry no base prompt: compose nodes get '' (preserved by
      // wireExecutors) and forked children fall back to the handoff contract.
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      // Use the per-session config.cwd (set by session-spawn.ts to the resolved
      // per-task cwd) rather than the daemon-wide opts.cwd, so subagents,
      // skills, and compose nodes forked from a task session inherit the
      // task's working directory — the core requirement for fixing grep/glob
      // timeouts in cron tasks that pin to a repo.
      // Precedence (already resolved by session-spawn.ts): task.cwd ?? AFK_DAEMON_CWD ?? process.cwd().
      ...(config.cwd !== undefined ? { cwd: config.cwd, nestedCwd: config.cwd } : (opts.cwd !== undefined ? { cwd: opts.cwd, nestedCwd: opts.cwd } : {})),
      ...(config.traceWriter !== undefined
        ? { traceWriter: config.traceWriter, skillTraceWriter: config.traceWriter }
        : {}),
      // No backgroundRegistry: background dispatch is interactive-only.
      workspaceStore,
    });
    const mcpManager = config.mcpManager;
    const mcpToolWireNames = mcpManager?.getMcpToolWireNames() ?? [];

    const provider = parseProvider(undefined, {
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore, stateStore, workspaceStore,
      model: String(opts.model),
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    }) ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: [
          ...BUILTIN_TOOL_NAMES,
          ...MEMORY_TOOL_NAMES,
          ...STATE_TOOL_NAMES,
          ...AWARENESS_TOOL_NAMES,
          ...WORKSPACE_TOOL_NAMES,
          'agent',
          'skill',
          'compose',
          ...mcpToolWireNames,
        ],
      },
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore, stateStore, workspaceStore,
      surface: 'daemon',
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    });

    // Opt-in top-level tool-use-round ceiling. Explicit caller config wins;
    // AFK_MAX_TOOL_USE_ITERATIONS is the fallback (undefined/<=0 → unlimited, no
    // behavior change). Resolved after `...config` so an explicit value on the
    // caller's config takes precedence over the env default. This is the
    // production chokepoint the scheduler routes every task through, so it also
    // caps scheduler/cron-spawned top-level sessions.
    const daemonMaxToolUseIterations = config.maxToolUseIterations ?? getMaxToolUseIterations();
    const session = new AgentSession(injectGoalPrompt(injectCompanionPrimer(injectHotMemory({
      ...config,
      provider,
      // Daemon sessions are headless by default: no human watches to answer
      // ask_question. Pull tasks set isNonInteractive: false in the caller's
      // config (scheduler.ts spawnSession) so they keep the ask_question tool
      // available (the handoff handler persists the question for async reply).
      // Use ?? so an explicit false from the caller's config passes through;
      // cron/sessionstart callers omit the field and get the safe default (true).
      isNonInteractive: config.isNonInteractive ?? true,
      // Cascade-abort and drain in-flight children before the writer seals,
      // so a wave still running when this session ends emits real `cancelled`
      // rows instead of vanishing (#733).
      drainSubagents: (reason) =>
        rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
      // User-facing surface for trace `origin` attribution. Forced after
      // `...config` for the same reason as `isNonInteractive`: every daemon +
      // scheduler/cron session routes through here → 'daemon'.
      surface: 'daemon',
      ...(daemonMaxToolUseIterations !== undefined
        ? { maxToolUseIterations: daemonMaxToolUseIterations }
        : {}),
    }))), ownedTraceWriter);
    // Subagent-success rollup: wire both the root manager and the compose
    // executor so all subagent token/cost data (including compose DAG nodes)
    // accumulates into this session's session_sealed telemetry. Late-bound
    // here because the session is constructed after the executors. The daemon
    // creates a fresh session per task tick, so this wiring is per-tick too —
    // each session's costs roll into ITS OWN sealed payload, not a shared one.
    rootManager.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
    composeExecutor.setOnSubagentSucceeded((usage, costUsd) => {
      session.recordSubagentCompletion(usage, costUsd);
    });
    return session;
  };
}
