/**
 * Per-query tool-dispatcher construction for {@link AnthropicDirectProvider}.
 *
 * Extracted from `index.ts` (#824) as a pure function over explicit params:
 * everything the original method read off `this` now arrives through
 * {@link BuildDispatcherDeps}, and the two mutable MCP caches are threaded as
 * getter/setter pairs (the `cwd-dependents.ts` convention) so the provider
 * keeps ownership of the fields while this module keeps the invalidation
 * logic.
 *
 * Invariant: handler registration order encodes a precedence ladder and must
 * not be reordered — builtins first, then memory, then the awareness handler,
 * then consumer-registered custom tools (skipped on collision, so a builtin
 * always wins), then MCP handlers. Schema order mirrors it: provider schemas,
 * then MCP, then the plan-exit tool last. Both orders are observable on the
 * wire, and the collision skips make them semantically load-bearing rather
 * than cosmetic.
 *
 * @module agent/providers/anthropic-direct/build-dispatcher
 */

import type { CanUseTool } from '../../types/sdk-types.js';
import type { PlanExitControls } from '../../types/config-types.js';
import type { HookRegistry } from '../../hooks.js';
import type { MemoryStore } from '../../memory/index.js';
import type { WorkspaceStore } from '../../workspace/workspace-store.js';
import type { StateStore } from '../../state/state-store.js';
import { createStateHandlers } from '../../state/state-tools.js';
import { createWorkspaceHandlers } from '../../workspace/index.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../tools/compose-executor.js';
import type { TraceSink } from '../../trace/index.js';
import type { AnthropicToolDef, ToolHandler } from '../../tools/types.js';
import type { CustomToolDef } from '../../tools/custom-tool.js';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import type { RuntimeStateSource } from '../../awareness/index.js';
import type { SpawnedPidRegistry } from '../../tools/handlers/pid-registry.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createBuiltinHandlers } from '../../tools/handlers/index.js';
import {
  exitPlanModeTool,
  createExitPlanModeHandler,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/handlers/exit-plan-mode.js';
import { createMemoryHandlers } from '../../memory/index.js';
import { createGetRuntimeStateHandler } from '../../awareness/index.js';
import { resolveSessionHookRegistry } from '../../hooks.js';
import {
  withMcpToolsAllowed,
  withCustomToolsAllowed,
  type ToolPermissionConfig,
} from '../../tools/permissions.js';
import { pathContainmentBypassed } from '../../permission-policy.js';

/** Per-call options — the session-scoped half of the dispatcher inputs. */
export interface BuildDispatcherOptions {
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
  env?: Record<string, string>;
  sessionId?: string;
  parentSessionId?: string;
  /**
   * This fork's own subagent id. Stamped onto every `hook_decision` the
   * dispatcher emits so a policy block is attributable to the child that
   * provoked it (parity with what `tool_call` already records). Undefined on
   * a top-level session.
   */
  subagentId?: string;
  /**
   * Explicit "this session is a forked subagent" signal carrying the
   * per-result output-cap budget (#661). Set to MODEL_CAP_BYTES by
   * `SubagentManager.forkSubagent` for EVERY fork; undefined on a top-level
   * session. Arms the dispatcher's `maxOutputBytes` backstop declaratively.
   */
  subagentToolOutputCapBytes?: number;
  traceWriter?: TraceSink;
  /**
   * Live source for the `get_runtime_state` tool. Constructed per-query
   * in `query()` so the handler closure captures the model name and
   * config-level identity fields. When undefined the handler is not
   * registered — the model would see "Unknown tool" if it called
   * `get_runtime_state` against a dispatcher built without a source.
   */
  runtimeStateSource?: RuntimeStateSource;
  /**
   * Session-scoped hook registry sourced from `AgentConfig.hookRegistry`.
   * Threaded here so `PreToolUse`/`PostToolUse` hooks (notably the
   * plan-mode gate) fire on the per-query dispatcher. Production entry
   * points construct the provider WITHOUT a constructor-time
   * `hookRegistry` and supply the session registry on the query config
   * instead, so falling back to `deps.hookRegistry` when this is unset
   * preserves any constructor-provided registry.
   */
  hookRegistry?: HookRegistry;
  /**
   * Session-control bridge for the model-callable `exit_plan_mode` tool,
   * forwarded from the query config (top-level sessions only). When set AND
   * `permissionMode === 'plan'`, the handler + schema are registered.
   */
  planExitControls?: PlanExitControls;
  /**
   * Session-scoped PID registry. When present, the `wait_for` process
   * condition restricts PID probing to session-owned child processes (#1430).
   * Top-level sessions always supply one (created once per session in
   * `AnthropicDirectProvider`). Forked children inherit their parent's
   * restrictions via their own dispatcher and do not share the registry.
   */
  spawnedPidRegistry?: SpawnedPidRegistry;
}

/**
 * Provider-scoped collaborators. These were `this.*` reads before the
 * extraction; the MCP cache accessors keep the fields owned by the provider
 * instance so invalidation via `onToolsRefreshed` still works.
 */
export interface BuildDispatcherDeps {
  memoryStore: MemoryStore;
  workspaceStore?: WorkspaceStore;
  stateStore?: StateStore;
  surface: string;
  readOnlyMemory: boolean;
  readOnlyBash: boolean;
  customTools: readonly CustomToolDef[];
  mcpManager: import('../../mcp/index.js').McpManager | undefined;
  schemas: readonly AnthropicToolDef[];
  hookRegistry: HookRegistry | undefined;
  permissions: ToolPermissionConfig | undefined;
  canUseTool: CanUseTool | undefined;
  subagentExecutor: SubagentExecutor | undefined;
  skillExecutor: SkillExecutor | undefined;
  composeExecutor: ComposeExecutor | undefined;
  /** The provider itself — it implements GrantManager for this session. */
  sessionGrantManager: GrantManager;
  getMcpToolsCache: () => AnthropicToolDef[] | null;
  setMcpToolsCache: (value: AnthropicToolDef[] | null) => void;
  getMcpHandlersCache: () => Map<string, ToolHandler> | null;
  setMcpHandlersCache: (value: Map<string, ToolHandler> | null) => void;
}

/**
 * Build a per-query tool dispatcher with a bash handler closed over the
 * session's permission mode and working directory — eliminates the
 * process.env race when concurrent sessions run in the same process with
 * different modes, and the `process.cwd()` race when concurrent sessions
 * run in different worktrees (bash/grep would otherwise spawn against
 * the host's `process.cwd()` instead of the session's worktree).
 *
 * The shared read/write root arrays are passed by reference so that grant
 * mutations (via `/allow-dir`) survive across turns without requiring a new
 * dispatcher instance.
 */
export function buildDispatcher(
  deps: BuildDispatcherDeps,
  permissionMode: string,
  opts?: BuildDispatcherOptions,
): SessionToolDispatcher {
  const handlers = createBuiltinHandlers(permissionMode, opts?.cwd);
  const memoryHandlers = createMemoryHandlers(
    deps.memoryStore,
    undefined,
    deps.surface,
  );
  // Read-only memory: register `memory_search` only. The dispatcher's
  // unknown-tool path produces a clear error if the model attempts
  // `memory_update` / `procedure_write` despite the schema being absent.
  for (const [name, handler] of memoryHandlers) {
    if (deps.readOnlyMemory && name !== 'memory_search') continue;
    handlers.set(name, handler);
  }
  // Workspace tool: workspace_publish. Registered for ALL sessions —
  // children publish findings; the parent can too. No readOnly gate
  // (workspace is per-session and ephemeral, unlike memory).
  // Skipped when workspace is disabled (AFK_WORKSPACE_DISABLED=1).
  if (deps.workspaceStore !== undefined) {
    const wsHandlers = createWorkspaceHandlers(deps.workspaceStore, opts?.sessionId ?? '', opts?.subagentId);
    for (const [name, handler] of wsHandlers) {
      handlers.set(name, handler);
    }
  }
  // State store tools: state_get, state_put, state_cas, state_delete, state_query.
  // Read-only sessions get only state_get and state_query (mirroring the
  // readOnlyMemory gate for memory_search above).
  if (deps.stateStore !== undefined) {
    const stateHandlers = createStateHandlers(deps.stateStore, opts?.sessionId);
    for (const [name, handler] of stateHandlers) {
      if (deps.readOnlyMemory && name !== 'state_get' && name !== 'state_query') continue;
      handlers.set(name, handler);
    }
  }
  if (opts?.runtimeStateSource) {
    handlers.set('get_runtime_state', createGetRuntimeStateHandler(opts.runtimeStateSource));
  }
  // Invariant: custom (consumer-registered) handlers are registered AFTER
  // all builtins and the runtime-state handler, and BEFORE MCP handlers.
  // If a custom tool name collides with a builtin already in `handlers`,
  // the builtin wins (we skip the custom registration). This prevents a
  // user-supplied tool from silently overriding a built-in capability.
  for (const t of deps.customTools) {
    if (!handlers.has(t.schema.name)) {
      handlers.set(t.schema.name, t.handler);
    }
  }
  // MCP handlers + schemas — served from a cache that is invalidated by
  // `onToolsRefreshed` (fired after every `refreshServer()` / `completeAuth()`
  // call).  This preserves the Option A correctness guarantee — the cache
  // always reflects the live nameRegistry state — while avoiding redundant
  // allocation and iteration on every query when the tool list has not changed.
  // Pre/PostToolUse hooks fire for MCP tools automatically via the dispatcher
  // (`tools/dispatcher.ts:247,342`).
  if (deps.mcpManager) {
    if (!deps.getMcpToolsCache()) {
      deps.setMcpToolsCache(deps.mcpManager.getMcpTools());
    }
    if (!deps.getMcpHandlersCache()) {
      deps.setMcpHandlersCache(deps.mcpManager.getMcpHandlers());
    }
    // Non-null assertion rather than `?? []`: the original iterated the cache
    // field directly, so a manager returning a nullish handler map threw here.
    // A `?? []` fallback would convert that loud failure into a silent
    // zero-handler registration — a behavior change, not a hardening.
    for (const [name, handler] of deps.getMcpHandlersCache()!) {
      handlers.set(name, handler);
    }
  }
  const mcpSchemas = deps.getMcpToolsCache() ?? [];
  // Plan-exit tool: the model-callable `exit_plan_mode`, registered RESIDENT
  // whenever the session supplied control callbacks (top-level sessions only —
  // subagents never get planExitControls). NOT gated on the construction-time
  // `permissionMode`: the dispatcher is built once per query() and is NOT
  // rebuilt by setPermissionMode, so a mode-gated registration here left the
  // tool permanently unwired for the common "enter plan mode AFTER launch"
  // flow (Shift+Tab / `/plan`), and the model got "Unknown tool exit_plan_mode".
  // Callability is instead gated per-turn on the LIVE mode: query.ts filters
  // this tool out of the advertised tool list on non-plan turns, so the model
  // is offered it exactly when it is actionable — and it becomes callable the
  // instant plan mode is entered mid-session, with no query rebuild.
  const planExitControls = opts?.planExitControls;
  if (planExitControls) {
    handlers.set(EXIT_PLAN_MODE_TOOL_NAME, createExitPlanModeHandler(planExitControls));
  }
  return new SessionToolDispatcher({
    handlers,
    // This provider IS the session's GrantManager. Passing it here lets the
    // dispatcher inject it onto PreToolUse/PostToolUse contexts, so the
    // path-approval + bash-restriction hooks resolve THIS session's live
    // grants (a forked child's own writeRoots) rather than the process-global
    // ref pinned to the top-level session (#435/#514). getGrants() reads the
    // same _sharedReadRoots/_sharedWriteRoots the dispatcher shares by
    // reference, so hook and handler stay in lockstep.
    sessionGrantManager: deps.sessionGrantManager,
    // Path-containment bypass: bypassPermissions (explicit) AND autonomous
    // (AFK) both carry allowAll:true so path containment + the path-approval
    // prompt are disabled per-call. In AFK the afk-mode-gate is the safety
    // ceiling (see agent/permission-policy.ts).
    allowAll: pathContainmentBypassed(permissionMode),
    // Constraint (semantic invariant): MCP schemas appended AFTER builtins
    // so builtin tool names always take precedence in any overlap. The
    // plan-exit schema is appended last, RESIDENT whenever planExitControls is
    // present (top-level); query.ts filters it out of the advertised tool list
    // on non-plan turns so the model sees it only when it is actionable.
    schemas: [
      ...deps.schemas,
      ...mcpSchemas,
      ...(planExitControls ? [exitPlanModeTool] : []),
    ],
    // Session hook registry via the one canonical resolver (query-scoped
    // config registry wins over any constructor-provided one). Without this
    // the plan-mode gate (the sole built-in PreToolUse hook) never reached
    // the dispatcher and write tools ran unblocked in plan mode (c6892c6).
    hookRegistry: resolveSessionHookRegistry(opts?.hookRegistry, deps.hookRegistry),
    // Union live MCP wire-names AND consumer-registered custom-tool names into
    // the (statically-snapshotted) allowlist so neither is rejected by the
    // gate while present in `schemas`/`handlers`. No-op when there is no
    // allowlist (undefined => all allowed) or nothing to union. Registering a
    // custom tool is the grant (same as connecting an MCP server); restricted
    // sub-agents carry no customTools, so this never widens their allowlist.
    permissions: withCustomToolsAllowed(
      deps.mcpManager
        ? withMcpToolsAllowed(deps.permissions, deps.mcpManager.getMcpToolWireNames())
        : deps.permissions,
      deps.customTools.map((t) => t.schema.name),
    ),
    subagentExecutor: deps.subagentExecutor,
    skillExecutor: deps.skillExecutor,
    composeExecutor: deps.composeExecutor,
    // In-process permission callback (Dim 8). No-op when unset; forwarded by
    // reference so it composes with the static allowlist in the dispatcher.
    ...(deps.canUseTool !== undefined ? { canUseTool: deps.canUseTool } : {}),
    cwd: opts?.cwd,
    readRoots: opts?.readRoots,
    writeRoots: opts?.writeRoots,
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    sessionId: opts?.sessionId,
    parentSessionId: opts?.parentSessionId,
    ...(opts?.subagentId !== undefined ? { subagentId: opts.subagentId } : {}),
    // Central output-cap backstop (#661), FORK-SCOPED. Armed from the
    // explicit `subagentToolOutputCapBytes` signal that
    // `SubagentManager.forkSubagent` stamps (as MODEL_CAP_BYTES = 100KB) on
    // EVERY forked child — the single choke point for the agent-tool, skill,
    // and compose fork paths. A value here means "forked child" ⇒ bound each
    // tool result at that budget via headAndTail, containing the whole
    // overflow crash class (MCP dumps, browser output, read_file of a huge
    // file). The top-level session is built directly (never via forkSubagent),
    // leaves this unset, and is therefore UNCAPPED (behavior unchanged). This
    // replaces the prior `parentSessionId !== undefined` gate, which missed
    // skill-forked descendants whose parent carries no sessionId (a stub
    // parent) and were left silently exposed.
    ...(opts?.subagentToolOutputCapBytes !== undefined
      ? { maxOutputBytes: opts.subagentToolOutputCapBytes }
      : {}),
    ...(opts?.traceWriter ? { traceWriter: opts.traceWriter } : {}),
    // Read-only-skill bash gate: forwarded from the provider's stored flag
    // (set by createChildProviderFactory / buildReadOnlyReconProvider) so a
    // read-only skill's forked child can't run mutating shell commands.
    readOnlyBash: deps.readOnlyBash,
    // #1430: PID registry — gates wait_for process condition to session-owned PIDs.
    ...(opts?.spawnedPidRegistry !== undefined ? { spawnedPidRegistry: opts.spawnedPidRegistry } : {}),
  });
}
