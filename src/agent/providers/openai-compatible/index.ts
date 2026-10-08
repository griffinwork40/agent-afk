/**
 * `openai-compatible` provider — talks directly to OpenAI's Chat Completions
 * API (and any compatible endpoint via `baseURL`). Replaces the
 * `@openai/codex-sdk`-backed `openai-codex` provider at the model-router
 * level; see `providers/index.ts` for the cutover (slice 5).
 *
 * Construction options mirror {@link AnthropicDirectProvider} so callers
 * (`shared-helpers.ts:parseProvider`, `interactive/bootstrap.ts`, etc.) can
 * swap providers by changing one line and have hooks/skills/subagents/
 * compose flow through transparently.
 *
 * @module agent/providers/openai-compatible
 */

import type {
  ModelProvider,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderCompleteArgs,
} from '../../provider.js';
import type { HookRegistry } from '../../hooks.js';
import { resolveSessionHookRegistry } from '../../hooks.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../tools/compose-executor.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import { composeDispatcherPermissions } from '../../tools/permissions-compose.js';
import { snapshotOperatorOptions, operatorDispatcherToolDefs } from '../../tools/operator-denied-dispatcher.js';
import type { CanUseTool } from '../../types/sdk-types.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { PathGrantManager } from '../../tools/grant-manager.js';
import { pathContainmentBypassed } from '../../permission-policy.js';
import { createBuiltinHandlers } from '../../tools/handlers/index.js';
import { SpawnedPidRegistry } from '../../tools/handlers/pid-registry.js';
import {
  exitPlanModeTool,
  createExitPlanModeHandler,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/handlers/exit-plan-mode.js';
import {
  builtinToolSchemas,
  agentTool,
  skillTool,
  composeTool,
} from '../../tools/schemas.js';
import { MemoryStore, createMemoryHandlers, guardChildHotWrites, isForkedChildSession, memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import { WorkspaceStore, createWorkspaceHandlers, workspacePublishTool, workspaceQueryTool } from '../../workspace/index.js';
import { StateStore } from '../../state/state-store.js';
import { createStateHandlers } from '../../state/state-tools.js';
import { makeDefaultMemoryStore, makeDefaultStateStore } from '../shared/provider-stores.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import { selectBaseSchemas } from './base-schemas.js';
import { userAttentionFrom } from '../../tools/user-yield.js';
import { buildQueryFromConfig } from './query.js';
import { isCustomOpenAIEndpoint } from './query/fast-tier-session.js';
import { completeWithWire, type OpenAIOneShotInput } from './complete-wire.js';
import {
  getRuntimeStateTool,
  createGetRuntimeStateHandler,
  wrapDispatcherWithRuntimeState,
  buildRuntimeStateSource,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { resolveSessionId, registerSessionPresence } from './session-wiring.js';
import { buildSystemPromptWiring } from './system-prompt-wiring.js';
import { type ChildSessionOptions, isStateRestricted, stateToolSchemas, stateReadToolSchemas } from './index.child-session.js';
import { headlessSignalOpts, interactivityOpts, sessionRegistryOpts, type BuildDispatcherOpts } from './index.dispatcher-opts.js';

const PROVIDER_NAME = 'openai-compatible';

/**
 * Construction options. The same surface anthropic-direct exposes — modulo
 * Anthropic-specific knobs (client factory, OAuth keychain) — so callers
 * can build either provider with the same dependency bundle.
 */
export interface OpenAICompatibleProviderOptions extends ChildSessionOptions {
  /** Override the default `https://api.openai.com/v1` endpoint. */
  baseURL?: string;
  /**
   * Optional default headers for every client built by this provider
   * (e.g. xAI CLI-proxy identity). Per-query overrides may also be supplied
   * via {@link OpenAICompatibleProvider.setEndpointDefaults}.
   */
  defaultHeaders?: Record<string, string>;
  /** Hook registry — PreToolUse / PostToolUse fire from the dispatcher. */
  hookRegistry?: HookRegistry;
  /** Tool permission gate (allowlist/denylist). */
  permissions?: ToolPermissionConfig;
  /** In-process permission callback, forwarded to the session dispatcher. */
  canUseTool?: CanUseTool;
  subagentExecutor?: SubagentExecutor;
  skillExecutor?: SkillExecutor;
  composeExecutor?: ComposeExecutor;
  /** Shared memory store (avoids dual SQLite handles when CLI builds it once). */
  memoryStore?: MemoryStore;
  workspaceStore?: WorkspaceStore;
  stateStore?: StateStore;
  /** UI surface tag forwarded to memory handlers ('cli' | 'telegram' | etc.). */
  surface?: string;
  /**
   * When true, expose and wire only the read-only `memory_search` tool.
   * Child sessions set this so OpenAI-routed subagents follow the same
   * provider-level memory-write embargo as Anthropic-routed subagents.
   */
  readOnlyMemory?: boolean;
  /**
   * When true, the per-query {@link SessionToolDispatcher} blocks mutating
   * `bash` commands (read-only recon allowed). Parity with
   * `AnthropicDirectProviderOptions.readOnlyBash`. Set by
   * `createChildProviderFactory` / `buildReadOnlyReconProvider` for a
   * read-only skill's forked child. Defaults to false.
   */
  readOnlyBash?: boolean;
  /**
   * Caller-provided dispatcher. When set, the provider does NOT build its
   * own — the caller owns lifecycle. Mirrors anthropic-direct's `externalTools`
   * option used by tests and the nesting fixture.
   */
  tools?: ToolDispatcher;
  /**
   * Optional MCP manager — mirrors `AnthropicDirectProviderOptions.mcpManager`.
   * When provided, every tool exposed by a `connected` MCP server is merged
   * into the provider's tool schema list and the per-query dispatcher's
   * handler map. Hooks fire for MCP tools automatically via the dispatcher.
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * In-process custom tools registered by the library consumer. Mirrors
   * `AnthropicDirectProviderOptions.customTools` for full provider parity.
   * Each entry supplies an `AnthropicToolDef` schema (added to the provider's
   * schema list at construction time) and a `ToolHandler` (registered in the
   * per-query dispatcher's handler map).
   *
   * Precedence: builtins > custom (a custom tool whose name collides with a
   * builtin is silently skipped — see `buildDispatcher`).
   */
  customTools?: import('../../tools/custom-tool.js').CustomToolDef[];
  /** `/fast` controller (top-level REPL sessions); sends service_tier "priority" when eligible. */
  fastModeController?: import('../../fast-mode.js').FastModeController;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  private readonly providerOpts: OpenAICompatibleProviderOptions;
  private _memoryStore: MemoryStore | undefined;
  private readonly workspaceStore: WorkspaceStore | undefined;
  private _stateStore: StateStore | undefined;
  private readonly schemas: AnthropicToolDef[];
  /**
   * Mutable per-session endpoint headers (xAI CLI proxy). Construction-time
   * `defaultHeaders` are the baseline; {@link setEndpointDefaults} can replace
   * them when a composing provider (xai) resolves mode-specific headers.
   */
  private _defaultHeaders: Record<string, string> | undefined;

  /**
   * Mutable read-root list shared across per-query dispatchers (same shared-
   * reference semantics as `AnthropicDirectProvider._sharedReadRoots` — see
   * the docstring on `resolveProvider()` for why this matters).
   */
  private _sharedReadRoots: string[] | undefined;
  private _sharedWriteRoots: string[] | undefined;
  /**
   * Current permission mode, refreshed per `query()` — read by `getGrants()` so
   * the path-approval hook's `allowAll` matches the per-query dispatcher's.
   */
  private _currentPermissionMode = 'default';
  /** Tracks the most recently seen cwd — doubles as the migrating non-revocable anchor (Option A). */
  private _sharedCurrentCwd: string | undefined;
  /**
   * Presence-registration guard — same semantics as
   * `AnthropicDirectProvider._presenceSessionId`. `null` = not yet registered.
   */
  private _presenceSessionId: string | null = null;

  /**
   * Session id minted for a top-level session that supplied none — same
   * semantics as `AnthropicDirectProvider._mintedSessionId`. Memoized so the id
   * stays stable across turns and the ledger directory cannot move out from
   * under the presence file the Telegram watcher is following.
   */
  private _mintedSessionId: string | null = null;

  /**
   * Session-scoped PID registry — mirrors AnthropicDirectProvider._spawnedPidRegistry.
   * Threaded into every per-query dispatcher so wait_for can gate on session-owned
   * PIDs (#1430).
   */
  private readonly _spawnedPidRegistry = new SpawnedPidRegistry();

  constructor(opts: OpenAICompatibleProviderOptions = {}) {
    this.providerOpts = snapshotOperatorOptions(opts);
    this._defaultHeaders = opts.defaultHeaders;
    this._memoryStore = opts.memoryStore;
    this.workspaceStore = opts.workspaceStore;
    this._stateStore = opts.stateStore;

    const schemas: AnthropicToolDef[] = [...builtinToolSchemas];
    // Executor-supplied `agent` def advertises named agent types when a
    // registry is wired — parity with anthropic-direct (see agents/tool-def.ts).
    if (opts.subagentExecutor) schemas.push(opts.subagentExecutor.describeAgentTool?.() ?? agentTool);
    if (opts.skillExecutor) schemas.push(skillTool);
    if (opts.composeExecutor) schemas.push(composeTool);
    if (opts.readOnlyMemory === true) {
      schemas.push(memorySearchTool);
    } else {
      schemas.push(...memoryToolSchemas);
    }
    if (isStateRestricted(opts.readOnlyMemory, opts.readOnlyState)) {
      schemas.push(...stateReadToolSchemas);
    } else {
      schemas.push(...stateToolSchemas);
    }
    // Workspace (per-session publish) + awareness (runtime-state) — parity
    // with anthropic-direct/provider-schemas.ts. Keep the workspace schema in
    // lockstep with its handler when AFK_WORKSPACE_DISABLED omits the store.
    // workspace_subscribe schema is intentionally excluded: the handler requires
    // SubagentHandleImpl wiring (setSubscribeHandler) not yet supported by this provider.
    // Only publish + query are advertised; subscribe goes through anthropic-direct only.
    schemas.push(...(this.workspaceStore !== undefined ? [workspacePublishTool, workspaceQueryTool] : []), getRuntimeStateTool);
    // Custom (consumer-registered) tool schemas are appended last so their
    // names never silently shadow a builtin. A custom schema whose name
    // collides with an already-present builtin (or an earlier custom tool) is
    // SKIPPED: otherwise the wire `tools` array carries a duplicate name and
    // providers that require unique tool names reject the whole request. This
    // mirrors the handler-map precedence in buildDispatcher (builtins win).
    for (const t of opts.customTools ?? []) {
      if (!schemas.some((s) => s.name === t.schema.name)) schemas.push(t.schema);
    }
    this.schemas = schemas;
  }

  /**
   * Update construction-time baseURL and/or default headers for subsequent
   * `query()` calls. Used by the composing `xai` provider after resolving
   * mode-specific endpoints (api.x.ai vs CLI chat proxy).
   */
  setEndpointDefaults(defaults: {
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
  }): void {
    if (defaults.baseURL !== undefined) {
      this.providerOpts.baseURL = defaults.baseURL;
    }
    if (defaults.defaultHeaders !== undefined) {
      this._defaultHeaders = defaults.defaultHeaders;
    }
  }

  query(args: ProviderQueryArgs): ProviderQuery {
    const config = args.config;
    const permissionMode = config.permissionMode ?? 'default';
    this._currentPermissionMode = permissionMode;

    // Lazily init the shared root arrays (mirrors AnthropicDirectProvider).
    this.ensureSharedRoots(config.cwd);
    if (config.readRoots && this._sharedReadRoots && this._sharedReadRoots.length <= 1) {
      this._sharedReadRoots.length = 0;
      this._sharedReadRoots.push(...config.readRoots);
    }
    if (config.writeRoots && this._sharedWriteRoots && this._sharedWriteRoots.length <= 1) {
      this._sharedWriteRoots.length = 0;
      this._sharedWriteRoots.push(...config.writeRoots);
    }

    // Awareness layer source — same lazy-binding pattern as anthropic-direct:
    // `getEnabledToolNames` reads through `dispatcher` after assignment below.
    let dispatcher: ToolDispatcher;
    const modelName = typeof config.model === 'string' ? config.model : String(config.model);

    // Mutable cwd cell (#876 fix) — a per-query local, NOT a class field:
    // `buildDispatcher`'s own cwd param is closed-over per-call for the same
    // reason (see its docstring) — a class field would let concurrent
    // sessions sharing the module-level `openaiCompatibleProvider` singleton
    // race on cwd. `getCwd` below reads THIS cell instead of the closed-over
    // `config.cwd`, and `rebuildEnvironmentBlock` (defined further down, once
    // every fragment it needs exists) updates it before re-deriving the
    // workspace snapshot and the `# Environment` block, so a mid-query
    // `setCwd()` (query.ts) is reflected in `get_runtime_state` AND the
    // system prompt the next turn sees — not just the dispatcher's resolve base.
    let _currentCwd = config.cwd ?? process.cwd();

    // Resolve FIRST so awareness source + dispatcher share the same id, not the
    // resume-only config.sessionId absent on fresh telegram/daemon sessions (#2353).
    const { resolved: resolvedSession, nextMintedSessionId } = resolveSessionId({
      config, surface: this.providerOpts.surface ?? 'cli', mintedSessionId: this._mintedSessionId,
    });
    this._mintedSessionId = nextMintedSessionId;

    const runtimeStateSource: RuntimeStateSource = buildRuntimeStateSource({
      surface: this.providerOpts.surface ?? 'cli',
      getCwd: () => _currentCwd,
      modelName,
      providerName: PROVIDER_NAME,
      permissionMode,
      ...(resolvedSession.id !== undefined ? { sessionId: resolvedSession.id } : {}),
      ...(config.parentSessionId !== undefined
        ? { parentSessionId: config.parentSessionId }
        : {}),
      ...(config.depth !== undefined ? { depth: config.depth } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
      ...(config.phaseRole !== undefined ? { phaseRole: config.phaseRole } : {}),
      getEnabledToolNames: () =>
        dispatcher instanceof SessionToolDispatcher
          ? dispatcher.toolDefs.map((t) => t.name)
          : [],
      getMcpTools: () => this.providerOpts.mcpManager?.getMcpTools() ?? [],
      getMcpServerStates: () => this.providerOpts.mcpManager?.getServerStates() ?? [],
      getSubagents: () =>
        this.providerOpts.subagentExecutor
          ? this.providerOpts.subagentExecutor.getSubagentsLite()
          : { active: [], backgroundJobs: [] },
    });

    // External-dispatcher branch mirrors anthropic-direct: when the caller
    // supplies their own dispatcher, wrap it so `get_runtime_state` is still
    // intercepted by the awareness handler. Otherwise the inner dispatcher
    // would return `Unknown tool` for a tool the model legitimately sees in
    // its schema list. See wrapDispatcherWithRuntimeState for the invariant.
    // Stamp toolDefs on the external-dispatcher wrapper so query.ts:246 picks
    // up the schema list — mirrors dispatcher-wiring.ts:219 (Anthropic path).
    dispatcher = this.providerOpts.tools
      ? Object.assign(wrapDispatcherWithRuntimeState(this.providerOpts.tools, runtimeStateSource),
          { toolDefs: operatorDispatcherToolDefs(this.providerOpts.tools, selectBaseSchemas(this.schemas, { isSkillDispatch: config.isSkillDispatch, isNonInteractive: config.isNonInteractive })) })
      : this.buildDispatcher(permissionMode, {
          ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
          ...(this._sharedReadRoots !== undefined ? { readRoots: this._sharedReadRoots } : {}),
          ...(this._sharedWriteRoots !== undefined ? { writeRoots: this._sharedWriteRoots } : {}),
          ...(resolvedSession.id !== undefined ? { sessionId: resolvedSession.id } : {}),
          ...(config.parentSessionId !== undefined ? { parentSessionId: config.parentSessionId } : {}),
          ...(config.rootSessionId !== undefined ? { rootSessionId: config.rootSessionId } : {}),
          ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
          ...(config.env !== undefined ? { env: config.env } : {}), // PLUGIN_ROOT, session TMPDIR
          // Fork-scoped central output cap (#661): forwarded from the child
          // config that forkSubagent stamped, arming maxOutputBytes for forks
          // only (top-level leaves it unset). Parity with anthropic-direct.
          ...(config.subagentToolOutputCapBytes !== undefined
            ? { subagentToolOutputCapBytes: config.subagentToolOutputCapBytes }
            : {}),
          ...(config.traceWriter !== undefined ? { traceWriter: config.traceWriter } : {}),
          ...(config.bashOutputTailReporter !== undefined
            ? { bashOutputTailReporter: config.bashOutputTailReporter }
            : {}),
          // #2542/#2735 detach registry + background process registry,
          // forwarded from AgentConfig (root REPL sessions only).
          ...sessionRegistryOpts(config),
          runtimeStateSource,
          ...(config.isSkillDispatch ? { isSkillDispatch: true } : {}),
          ...interactivityOpts(config), // ask_question strip + #2302 headless bash floor
          ...(config.hookRegistry !== undefined ? { hookRegistry: config.hookRegistry } : {}),
          ...(config.planExitControls !== undefined ? { planExitControls: config.planExitControls } : {}),
        });

    const buildOpts: NonNullable<Parameters<typeof buildQueryFromConfig>[2]> = {};
    // Undefined for forks — they keep the factory's own per-call mint.
    if (resolvedSession.id !== undefined) buildOpts.sessionIdOverride = resolvedSession.id;
    // Per-slot / per-session baseURL (`config.openaiBaseUrl`, set by
    // applySlotCredentials) wins over the construction-time global
    // (`providerOpts.baseURL`, from AFK_OPENAI_BASE_URL) so a tier bound to its
    // own endpoint overrides the process default. See model-slots Stage 2.
    const effectiveBaseURL = config.openaiBaseUrl ?? this.providerOpts.baseURL;
    if (effectiveBaseURL !== undefined) buildOpts.baseURL = effectiveBaseURL;
    if (this._defaultHeaders !== undefined) buildOpts.defaultHeaders = this._defaultHeaders;
    buildOpts.toolDispatcher = dispatcher;
    // Path-approval half of the live `/bypass` toggle: keep the provider's
    // `_currentPermissionMode` (read by getGrants().allowAll) in sync with the
    // query handle's mode. File-tool half is the dispatcher's setAllowAll().
    buildOpts.onPermissionMode = (mode: string) => {
      this._currentPermissionMode = mode;
    };
    if (this.providerOpts.mcpManager !== undefined) buildOpts.mcpManager = this.providerOpts.mcpManager;
    // Fast mode: top-level only (forks are built without a controller in tools/nesting.ts).
    if (this.providerOpts.fastModeController !== undefined && (config.depth ?? 0) === 0) buildOpts.fastTier = { controller: this.providerOpts.fastModeController, hasCustomEndpoint: isCustomOpenAIEndpoint(config.openaiBaseUrl ?? this.providerOpts.baseURL) };

    // Phase 2 — Presence file lifecycle (top-level CLI sessions only). Non-CLI
    // fresh sessions get a stable id (above) but no file (see session-wiring.ts).
    this._presenceSessionId = registerSessionPresence({
      resolved: resolvedSession, config, surface: this.providerOpts.surface ?? 'cli',
      runtimeStateSource, providerName: PROVIDER_NAME, modelName,
      currentPresenceSessionId: this._presenceSessionId,
    });

    // System-prompt assembly: fragment collection, environment-block builder, and
    // cwd-/base-rebuild factories (#876, #2420). Extracted to system-prompt-wiring.ts
    // (#2711/#2721 ratchet fix) so query() stays within the function-size ceiling.
    // Ordering: [toolBase, userSystem?, memoryPrompt, workspace?, hotMemory?,
    // goalPrompt?, envFragment, manifest?] — mirrors AnthropicDirectProvider.query().
    const spw = buildSystemPromptWiring({
      config,
      hasSkillExecutor: this.providerOpts.skillExecutor !== undefined,
      hasWorkspaceStore: this.workspaceStore !== undefined,
      readOnlyMemory: this.providerOpts.readOnlyMemory,
      readOnlyState: this.providerOpts.readOnlyState,
      resolvedSessionId: resolvedSession.id,
      surface: this.providerOpts.surface ?? 'cli',
      getCurrentCwd: () => _currentCwd,
      runtimeStateSource,
    });

    const patchedConfig: typeof config = { ...config, systemPrompt: spw.initialSystemPrompt };

    // Invariant (#876 + #2420): `_currentCwd` MUST be updated BEFORE calling
    // `spw.rebuildAfterCwdChange()` so `getCurrentCwd()` returns the new dir
    // when the `# Environment` block is re-derived. `patchedConfig.systemPrompt`
    // is reassigned IN PLACE (the same object `OpenAICompatibleQuery` holds as
    // `this.opts.config` by reference) so the next turn picks up the new string.
    buildOpts.onCwdChange = (newCwd: string): void => {
      _currentCwd = newCwd;
      this._sharedCurrentCwd = newCwd; // Option A: migrate the non-revocable anchor with the cwd.
      patchedConfig.systemPrompt = spw.rebuildAfterCwdChange();
    };
    buildOpts.systemPromptRebuildFactory = spw.systemPromptRebuildFactory;

    return buildQueryFromConfig(patchedConfig, args.prompt, buildOpts);
  }

  /**
   * Per-query dispatcher build. Closes over the session's permissionMode +
   * cwd so concurrent sessions in different worktrees don't race on
   * `process.cwd()`. Same pattern as `AnthropicDirectProvider.buildDispatcher`.
   */
  private buildDispatcher(
    permissionMode: string,
    opts: BuildDispatcherOpts,
  ): SessionToolDispatcher {
    const handlers = createBuiltinHandlers(permissionMode, opts.cwd);
    const memoryHandlers = guardChildHotWrites(createMemoryHandlers((this._memoryStore ??= makeDefaultMemoryStore()), undefined, this.providerOpts.surface ?? 'cli'), isForkedChildSession(this.providerOpts.readOnlyState, opts));
    for (const [name, handler] of memoryHandlers) {
      if (this.providerOpts.readOnlyMemory === true && name !== 'memory_search') continue;
      handlers.set(name, handler);
    }
    // Workspace tool: workspace_publish (per-session, ephemeral — no readOnly gate).
    // Skipped when workspace is disabled (AFK_WORKSPACE_DISABLED=1).
    if (this.workspaceStore !== undefined) {
      for (const [n, h] of createWorkspaceHandlers(this.workspaceStore, opts.sessionId ?? '', opts.subagentId)) handlers.set(n, h);
    }
    // State store tools: state_get, state_put, state_cas, state_delete, state_query.
    // Read-only sessions get only state_get and state_query.
    for (const [name, handler] of createStateHandlers((this._stateStore ??= makeDefaultStateStore()), opts.sessionId)) {
      if (isStateRestricted(this.providerOpts.readOnlyMemory, this.providerOpts.readOnlyState) && name !== 'state_get' && name !== 'state_query') continue;
      handlers.set(name, handler);
    }
    if (opts.runtimeStateSource) {
      handlers.set('get_runtime_state', createGetRuntimeStateHandler(opts.runtimeStateSource));
    }
    // Invariant: custom (consumer-registered) handlers are registered AFTER
    // all builtins and the runtime-state handler, and BEFORE MCP handlers.
    // If a custom tool name collides with a builtin already in `handlers`,
    // the builtin wins (we skip the custom registration). This prevents a
    // user-supplied tool from silently overriding a built-in capability.
    // Location: src/agent/providers/openai-compatible/index.ts buildDispatcher.
    for (const t of this.providerOpts.customTools ?? []) if (!handlers.has(t.schema.name)) handlers.set(t.schema.name, t.handler);
    // Plan-exit tool: registered RESIDENT whenever the session supplied control
    // callbacks (top-level sessions only). NOT gated on the construction-time
    // `permissionMode` — the dispatcher is built once per query() and is not
    // rebuilt by setPermissionMode, so a mode-gated registration left the tool
    // unwired for the "enter plan mode after launch" flow ("Unknown tool
    // exit_plan_mode"). Callability is gated per-turn on the LIVE mode instead:
    // query.ts drops it from the advertised tools on non-plan turns. Mirrors
    // AnthropicDirectProvider.buildDispatcher; schema appended below to match.
    const planExitControls = opts.planExitControls;
    if (planExitControls) {
      handlers.set(EXIT_PLAN_MODE_TOOL_NAME, createExitPlanModeHandler(planExitControls));
    }
    // MCP handlers + schemas — fetched fresh each query so that
    // `notifications/tools/list_changed` refreshes are picked up without
    // restarting the session (mirrors AnthropicDirectProvider.buildDispatcher).
    const mcpSchemas = this.providerOpts.mcpManager
      ? this.providerOpts.mcpManager.getMcpTools()
      : [];
    if (this.providerOpts.mcpManager) {
      for (const [name, handler] of this.providerOpts.mcpManager.getMcpHandlers()) {
        handlers.set(name, handler);
      }
    }

    // Surface-scoped builtin filter (skill-dispatch / non-interactive): see base-schemas.ts.
    const baseSchemas = selectBaseSchemas(this.schemas, opts);

    const dispatcherOpts: ConstructorParameters<typeof SessionToolDispatcher>[0] = {
      handlers,
      // Constraint (semantic invariant): MCP schemas appended AFTER builtins
      // so builtin tool names always take precedence in any overlap. Plan-exit
      // schema appended last, RESIDENT whenever planExitControls is present
      // (top-level); query.ts drops it from the advertised tools on non-plan
      // turns so the model sees it only when it is actionable.
      schemas: [...baseSchemas, ...mcpSchemas, ...(planExitControls ? [exitPlanModeTool] : [])],
      // Session hook registry via the one canonical resolver (query-scoped
      // config registry wins over any constructor-provided one). Mirrors
      // AnthropicDirectProvider; the required key on the dispatcher options
      // makes a silent drop (c6892c6) a compile error.
      hookRegistry: resolveSessionHookRegistry(opts.hookRegistry, this.providerOpts.hookRegistry),
    };
    // MCP + custom-tool unions, then operator denies LAST (shared with
    // AnthropicDirectProvider; invariant in tools/permissions-compose.ts).
    const effectivePermissions = composeDispatcherPermissions(
      this.providerOpts.permissions,
      this.providerOpts.mcpManager?.getMcpToolWireNames(),
      (this.providerOpts.customTools ?? []).map((t) => t.schema.name),
    );
    if (effectivePermissions !== undefined) dispatcherOpts.permissions = effectivePermissions;
    if (this.providerOpts.subagentExecutor !== undefined) dispatcherOpts.subagentExecutor = this.providerOpts.subagentExecutor;
    if (this.providerOpts.skillExecutor !== undefined) dispatcherOpts.skillExecutor = this.providerOpts.skillExecutor;
    if (this.providerOpts.composeExecutor !== undefined) dispatcherOpts.composeExecutor = this.providerOpts.composeExecutor;
    // In-process permission callback (Dim 8) — parity with anthropic-direct.
    if (this.providerOpts.canUseTool !== undefined) dispatcherOpts.canUseTool = this.providerOpts.canUseTool;
    if (opts.cwd !== undefined) dispatcherOpts.cwd = opts.cwd;
    if (opts.readRoots !== undefined) dispatcherOpts.readRoots = opts.readRoots;
    if (opts.writeRoots !== undefined) dispatcherOpts.writeRoots = opts.writeRoots;
    if (opts.sessionId !== undefined) dispatcherOpts.sessionId = opts.sessionId;
    if (opts.parentSessionId !== undefined) dispatcherOpts.parentSessionId = opts.parentSessionId;
    if (opts.rootSessionId !== undefined) dispatcherOpts.rootSessionId = opts.rootSessionId;
    if (opts.subagentId !== undefined) dispatcherOpts.subagentId = opts.subagentId;
    if (opts.env !== undefined) dispatcherOpts.env = opts.env;
    // Central output-cap backstop (#661), FORK-SCOPED — parity with
    // AnthropicDirectProvider.buildDispatcher. Armed from the explicit
    // `subagentToolOutputCapBytes` signal that `SubagentManager.forkSubagent`
    // stamps (as MODEL_CAP_BYTES = 100KB) on EVERY forked child; a value here
    // means "forked child" ⇒ bound each tool result at that budget via
    // headAndTail, containing the overflow crash class for forks. The top-level
    // session is built directly (never via forkSubagent), leaves this unset, and
    // stays UNCAPPED. Replaces the prior `parentSessionId !== undefined` gate,
    // which missed skill-forked descendants whose parent carries no sessionId.
    if (opts.subagentToolOutputCapBytes !== undefined)
      dispatcherOpts.maxOutputBytes = opts.subagentToolOutputCapBytes;
    if (opts.traceWriter !== undefined) dispatcherOpts.traceWriter = opts.traceWriter;
    if (opts.bashOutputTailReporter !== undefined) dispatcherOpts.bashOutputTailReporter = opts.bashOutputTailReporter;
    // Read-only-skill bash gate — parity with anthropic-direct. Forwarded from
    // the provider's construction-time flag so a read-only skill's forked
    // OpenAI-routed child also blocks mutating shell commands.
    if (this.providerOpts.readOnlyBash === true) dispatcherOpts.readOnlyBash = true;
    // Path-containment bypass: bypassPermissions (explicit) + autonomous (AFK)
    // both disable path containment for every per-call context.
    dispatcherOpts.allowAll = pathContainmentBypassed(permissionMode);
    // This provider IS the session's GrantManager — parity with
    // AnthropicDirectProvider.buildDispatcher. The dispatcher injects it onto
    // PreToolUse/PostToolUse contexts so path-scoped hooks resolve THIS
    // session's live grants (a forked child's own writeRoots), not the
    // process-global ref pinned to the top-level session (#435/#514).
    dispatcherOpts.sessionGrantManager = this;

    // #1430: PID registry — gates wait_for process condition to session-owned PIDs.
    // Parity with AnthropicDirectProvider.buildDispatcher.
    dispatcherOpts.spawnedPidRegistry = this._spawnedPidRegistry;
    // Yield contract: queued-message probe, late-bound off planExitControls (top-level only).
    if (planExitControls) dispatcherOpts.userAttention = userAttentionFrom(planExitControls);
    // #2542/#2735 detach registry + background process registry — parity with
    // AnthropicDirectProvider.buildDispatcher. Top-level REPL sessions only.
    Object.assign(dispatcherOpts, sessionRegistryOpts(opts), headlessSignalOpts(opts));

    return new SessionToolDispatcher(dispatcherOpts);
  }

  private ensureSharedRoots(cwd?: string): void {
    if (!this._sharedReadRoots) {
      const defaultRoots = cwd ? [cwd] : [];
      this._sharedReadRoots = defaultRoots.slice();
      this._sharedWriteRoots = defaultRoots.slice();
      // Track current cwd — doubles as the migrating non-revocable anchor (Option A).
      if (cwd && !this._sharedCurrentCwd) this._sharedCurrentCwd = cwd;
    }
  }

  // ---- GrantManager interface (parity with AnthropicDirectProvider) ----
  // Used by `/allow-dir` slash command. Same semantics: add to the shared
  // arrays so the next dispatcher.execute() picks up the grant without
  // requiring a new dispatcher.
  //
  // Signature parity: `source` and `sessionId` parameters match the
  // anthropic-direct signatures verbatim (index.ts:225-258 there) so the
  // slash-command call sites can drive either provider identically and the
  // audit log lands in the same `session-grants.jsonl` file regardless of
  // which provider is active. Without this, grant/revoke actions on OpenAI
  // sessions previously wrote no audit entries — a forensic blind spot.

  /**
   * Shared grant-state machine (issues #361/#362) — same hook bindings as
   * `AnthropicDirectProvider.grantManager`: lazy `ensureSharedRoots` init,
   * CURRENT cwd as the non-revocable anchor (Option A — migrates on cwd
   * change), mode-derived `allowAll`, per-call sessionId threading.
   * See grant-manager.ts.
   */
  private readonly grantManager = new PathGrantManager({
    getReadRoots: () => this._sharedReadRoots,
    getWriteRoots: () => this._sharedWriteRoots,
    ensureInitialized: () => this.ensureSharedRoots(),
    getProtectedRoot: () => this._sharedCurrentCwd,
    getAllowAll: () => pathContainmentBypassed(this._currentPermissionMode),
  });

  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.addReadRoot(absPath, source, sessionId);
  }

  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.addWriteRoot(absPath, source, sessionId);
  }

  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.revokeRoot(absPath, source, sessionId);
  }

  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[]; allowAll: boolean } {
    return this.grantManager.getGrants();
  }

  close(): void {
    this._memoryStore?.close();
    this.workspaceStore?.close();
    this._stateStore?.close();
  }

  /**
   * Single-shot completion (see {@link ModelProvider.complete}). Resolves auth
   * via {@link resolveOpenAIAuth} (the standard `OPENAI_API_KEY` →
   * `CODEX_API_KEY` → `~/.codex/auth.json` chain) and picks the wire from it
   * (`./complete-wire`): ChatGPT-subscription OAuth goes to the ChatGPT
   * backend over Responses, everything else over Chat Completions honouring
   * the provider's construction-time `baseURL` (local MLX / llama.cpp / vLLM
   * shims).
   * `args.baseUrl` overrides the construction option when both are present.
   */
  async complete(args: ProviderCompleteArgs): Promise<string> {
    const input: OpenAIOneShotInput = {
      model: args.model ?? 'gpt-4o-mini',
      system: args.system,
      user: args.user,
      maxTokens: args.maxTokens ?? 64,
    };
    if (args.apiKey !== undefined) input.apiKey = args.apiKey;
    const baseURL = args.baseUrl ?? this.providerOpts.baseURL;
    if (baseURL !== undefined) input.baseURL = baseURL;
    // Include endpoint defaults (e.g. xAI CLI-proxy identity headers set via
    // setEndpointDefaults) so complete() matches query() credentials.
    if (this._defaultHeaders !== undefined) input.defaultHeaders = this._defaultHeaders;
    if (args.signal) input.signal = args.signal;
    return completeWithWire(input);
  }
}

/**
 * Singleton default. Routed to by model family — see `providers/index.ts`.
 * Note: this instance is created without any executors/hooks; the typical
 * call site replaces it with one constructed via `OpenAICompatibleProvider`
 * options (see `shared-helpers.ts:parseProvider`).
 */
export const openaiCompatibleProvider: ModelProvider = new OpenAICompatibleProvider();

// Re-export auth + diagnostic surface for the `afk provider auth diagnose`
// command (slice 5 — CLI wiring).
export {
  resolveOpenAIAuth,
  formatAuthDiagnostic,
  type OpenAIAuthResolution,
  type OpenAIAuthSource,
} from './auth.js';
export { OpenAICompatibleQuery, __setOpenAIClientFactory } from './query.js';
