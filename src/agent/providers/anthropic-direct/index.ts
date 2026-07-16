/**
 * Anthropic-direct provider — adapter over `@anthropic-ai/sdk`.
 *
 * This provider talks to the Anthropic Messages API directly, bypassing the
 * Claude Agent SDK subprocess. Two auth modes are supported and selected by
 * token shape:
 *   - `sk-ant-oat01-*` → OAuth (Bearer + claude-code beta + cli identity
 *     headers + system-prompt billing-header). Recipe is the proven flow from
 *     `scripts/oauth-test.mjs`.
 *   - anything else → standard `x-api-key` path with no extra headers.
 *
 * Selection: `providerForModel()` routes all Claude models here, and
 * `resolveProvider()` constructs a **fresh instance per call** to keep the
 * per-session mutable state (`_sharedReadRoots` / `_sharedWriteRoots` /
 * `_initialResolveBase`) isolated across concurrent `AgentSession`s — see
 * `providers/index.ts:resolveProvider` for the rationale. Callers may also
 * inject a pre-built instance via `AgentConfig.provider`.
 *
 * @module agent/providers/anthropic-direct
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../../types/config-types.js';
import type { CanUseTool } from '../../types/sdk-types.js';
import type {
  ModelProvider,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderCompleteArgs,
} from '../../provider.js';
import {
  buildClientOptions,
  buildSystemPrefix,
  detectAuthMode,
} from './auth.js';
import { oneShotCompletion, type OneShotInput } from './oneshot.js';
import { makeTracingFetch } from './tracing-fetch.js';
import { ThrottleQueue } from './throttle-queue.js';
import { refreshClaudeCodeOauthToken } from '../../auth/keychain.js';
import { AnthropicDirectQuery } from './query.js';
import { pathContainmentBypassed } from '../../permission-policy.js';
import {
  resolveAutoCompactThreshold,
  resolveEffort,
  resolveMaxTokens,
  resolveThinkingParam,
  resumeHistoryToMessages,
} from './resolve-params.js';
// Re-export the pure param resolvers extracted to ./resolve-params.ts (issue
// #103) so the historical `from './index.js'` import path stays valid.
export { resolveEffort, resolveMaxTokens, resolveThinkingParam } from './resolve-params.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { PathGrantManager } from '../../tools/grant-manager.js';
import { createBuiltinHandlers } from '../../tools/handlers/index.js';
import {
  exitPlanModeTool,
  createExitPlanModeHandler,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/handlers/exit-plan-mode.js';
import type { PlanExitControls } from '../../types/config-types.js';
import { builtinToolSchemas, agentTool, skillTool, composeTool } from '../../tools/schemas.js';
import { resolveToolSystemPrompt, resolveMemorySystemPrompt } from '../../tools/system-prompt.js';
import { withMcpToolsAllowed, withCustomToolsAllowed, type ToolPermissionConfig } from '../../tools/permissions.js';
import type { HookRegistry } from '../../hooks.js';
import { resolveSessionHookRegistry } from '../../hooks.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../tools/compose-executor.js';
import type { TraceWriter } from '../../trace/index.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { buildSkillManifest } from '../../tools/skill-bridge.js';
import { MemoryStore, createMemoryHandlers, memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import { dumpIfEnabled } from '../../session/prompt-dump.js';
import { env } from '../../../config/env.js';
import { resolveQueryToken } from './query/token-resolution.js';
import {
  getRuntimeStateTool,
  createGetRuntimeStateHandler,
  wrapDispatcherWithRuntimeState,
  buildRuntimeStateSource,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { registerPresenceLifecycle } from './query/presence-lifecycle.js';
import { createCwdDependentsFactory } from './query/cwd-dependents.js';
import { assembleSystemPrompt, buildStableSystemPrefix } from './query/system-prompt.js';

const PROVIDER_NAME = 'anthropic-direct';
const DEFAULT_MODEL = 'claude-sonnet-5';

/** Test/factory hook: lets tests inject a stub Anthropic client.
 *
 * `baseURL` is the SDK's camelCase option name (forwarded by
 * `buildClientOptions` when the local-server path is active).
 */
export type AnthropicClientFactory = (
  opts: ({ authToken: string } | { apiKey: string }) & { baseURL?: string; fetch?: typeof fetch },
) => Anthropic;

let clientFactory: AnthropicClientFactory | null = null;

/**
 * Module-scope escape hatch used by integration tests; not part of the stable
 * surface. Pass `null` to restore the real `Anthropic` constructor.
 */
export function __setAnthropicClientFactory(
  factory: AnthropicClientFactory | null,
): void {
  clientFactory = factory;
}

/** Construction options for {@link AnthropicDirectProvider}. */
export interface AnthropicDirectProviderOptions {
  /** Pluggable tool dispatcher. When set, overrides the built-in SessionToolDispatcher. */
  tools?: ToolDispatcher;
  /** Hook registry for PreToolUse/PostToolUse integration. */
  hookRegistry?: HookRegistry;
  /** Tool permission configuration (allowlist). */
  permissions?: ToolPermissionConfig;
  /** In-process permission callback, forwarded to the session dispatcher. */
  canUseTool?: CanUseTool;
  /**
   * Optional client factory override. When set, takes precedence over the
   * module-scope `__setAnthropicClientFactory` hook. Useful for callers that
   * want to inject a pre-built client (e.g. with custom retries) without
   * touching module state.
   */
  clientFactory?: AnthropicClientFactory;
  /** Optional subagent executor. When provided, the Agent tool is included in the tool set. */
  subagentExecutor?: SubagentExecutor;
  /** Optional skill executor. When provided, the Skill tool is included in the tool set. */
  skillExecutor?: SkillExecutor;
  /** Optional compose executor. When provided, the Compose tool is included in the tool set. */
  composeExecutor?: ComposeExecutor;
  /** Shared MemoryStore instance. When set, avoids creating a second store. */
  memoryStore?: MemoryStore;
  /** Surface identifier for fact metadata (e.g. 'cli', 'daemon', 'telegram'). */
  surface?: string;
  /**
   * When true, the provider exposes only the read-only `memory_search` tool
   * (no `memory_update`, no `procedure_write`) and substitutes the
   * {@link MEMORY_SYSTEM_PROMPT_READONLY} variant in the system prompt.
   * Defaults to false. Set by {@link createChildProviderFactory} for
   * subagent / skill child sessions — only the parent writes memory.
   */
  readOnlyMemory?: boolean;
  /**
   * When true, the per-query {@link SessionToolDispatcher} blocks mutating
   * `bash` commands (read-only recon — git status/log/diff, ls, cat, find,
   * grep — is allowed). Set by `createChildProviderFactory` /
   * `buildReadOnlyReconProvider` for a read-only skill's forked child, paired
   * with `permissions.allowedTools = RECON_ALLOWED_TOOLS` (which strips
   * `write_file`/`edit_file`). Defaults to false.
   */
  readOnlyBash?: boolean;
  /**
   * Optional MCP manager. When provided, every tool exposed by a
   * `connected` MCP server is merged into the provider's tool schema list
   * and the per-query dispatcher's handler map. Pre/PostToolUse hooks
   * fire for MCP tools automatically via the dispatcher (see
   * `tools/dispatcher.ts:247,342`).
   *
   * Lifecycle: caller owns construction (`McpManager.fromConfig()`) and
   * teardown (`disconnectAll()`). Subagents inherit the same manager by
   * reference — never reconstructed per-fork.
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * In-process custom tools registered by the library consumer. Each entry
   * supplies an `AnthropicToolDef` schema (added to the provider's schema
   * list at construction time) and a `ToolHandler` (registered in the
   * per-query dispatcher's handler map).
   *
   * Custom tools run through the same permission gate and PreToolUse /
   * PostToolUse hooks as built-in tools — no bypass.
   *
   * Precedence: builtins > MCP > custom (a custom tool whose name collides
   * with a builtin is silently skipped — see `buildDispatcher`).
   */
  customTools?: import('../../tools/custom-tool.js').CustomToolDef[];
}

/**
 * Direct Anthropic SDK provider. Construction is cheap; the real per-session
 * lifecycle starts on `query()`.
 */
export class AnthropicDirectProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  /** Non-null only when the caller provides an explicit `opts.tools` override. */
  private readonly externalTools: ToolDispatcher | undefined;
  private readonly memoryStore: MemoryStore;
  private readonly providerFactory?: AnthropicClientFactory;
  private readonly skillExecutor?: SkillExecutor;
  // Fields retained for per-query dispatcher construction (fixes C2 env race).
  private readonly schemas: readonly import('../../tools/types.js').AnthropicToolDef[];
  private readonly hookRegistry: import('../../hooks.js').HookRegistry | undefined;
  private readonly permissions: ToolPermissionConfig | undefined;
  private readonly canUseTool: CanUseTool | undefined;
  private readonly subagentExecutor: import('../../tools/subagent-executor.js').SubagentExecutor | undefined;
  private readonly composeExecutor: import('../../tools/compose-executor.js').ComposeExecutor | undefined;
  private readonly surface: string;
  private readonly readOnlyMemory: boolean;
  /** When true, the per-query dispatcher blocks mutating bash (read-only skill child). */
  private readonly readOnlyBash: boolean;
  /** When set, MCP tools are merged into `schemas` + dispatcher handlers per query. */
  private readonly mcpManager: import('../../mcp/index.js').McpManager | undefined;
  /** In-process custom tools registered by the library consumer. */
  private readonly customTools: import('../../tools/custom-tool.js').CustomToolDef[];
  /**
   * Mutable read-root list shared by reference across all per-query
   * dispatchers. Mutations via `addReadRoot`/`revokeRoot` on any dispatcher
   * are immediately visible to the next query's dispatcher because they all
   * point at the same array. Initialized from `AgentConfig.readRoots` (or
   * from `[cwd]` as fallback) on the first `query()` call.
   */
  private _sharedReadRoots: string[] | undefined;
  /** Mutable write-root list — same shared-reference pattern as `_sharedReadRoots`. */
  private _sharedWriteRoots: string[] | undefined;
  /**
   * The session's current permission mode, refreshed on each `query()`. Read by
   * `getGrants()` so the path-approval hook sees `allowAll` in bypassPermissions
   * mode (the per-query dispatcher gets the same signal via `buildDispatcher`).
   */
  private _currentPermissionMode = 'default';
  /** The first cwd ever seen by ensureSharedRoots — non-revocable, mirrors the dispatcher-level guard. */
  private _initialResolveBase: string | undefined;
  /**
   * Tracks the most recently-set cwd (initial from `ensureSharedRoots`,
   * updated by `cwdDependentsFactory` on each `setCwd` call). Used to find
   * the prior cwd entry in `_sharedReadRoots`/`_sharedWriteRoots` so it can
   * be swapped in place instead of accumulating stale entries.
   *
   * Distinct from `_initialResolveBase` which is fixed at session start and
   * preserved as the /allow-dir non-revocable anchor even across renames.
   */
  private _currentCwd: string | undefined;
  /**
   * Cached result of `mcpManager.getMcpTools()`. Null means the cache is
   * dirty and must be repopulated on the next `buildDispatcher()` call.
   * Invalidated by `onToolsRefreshed` (fired after every `refreshServer()`
   * and `completeAuth()` call), so correctness is identical to the previous
   * per-query-fresh approach — just without redundant allocation each turn.
   */
  private _mcpToolsCache: import('../../tools/types.js').AnthropicToolDef[] | null = null;
  /** Cached result of `mcpManager.getMcpHandlers()`. Same dirty-flag semantics as `_mcpToolsCache`. */
  private _mcpHandlersCache: Map<string, import('../../tools/types.js').ToolHandler> | null = null;
  /**
   * Tracks whether the presence file and exit handler have been registered for
   * this provider instance. Guards against duplicate registration across turns
   * — `query()` is called once per conversation turn.
   *
   * `null`  = not yet registered (initial state)
   * `string` = the sessionId whose presence file was written
   */
  private _presenceSessionId: string | null = null;

  constructor(opts: AnthropicDirectProviderOptions = {}) {
    const schemas = [...builtinToolSchemas];
    // The executor supplies the `agent` tool def so a named-agent registry
    // can advertise its types in the description (see agents/tool-def.ts).
    // Optional chaining: test stubs without describeAgentTool fall back to
    // the static schema.
    if (opts.subagentExecutor) schemas.push(opts.subagentExecutor.describeAgentTool?.() ?? agentTool);
    if (opts.skillExecutor) schemas.push(skillTool);
    if (opts.composeExecutor) schemas.push(composeTool);
    // Read-only memory child sessions get only `memory_search`; full sessions
    // get the complete trio (search + update + procedure_write).
    if (opts.readOnlyMemory === true) {
      schemas.push(memorySearchTool);
    } else {
      schemas.push(...memoryToolSchemas);
    }
    // Awareness layer (Phase 1): the `get_runtime_state` tool is always
    // available — it reads in-memory state only, so there is no executor
    // gating like `agent`/`skill`/`compose`. The source is constructed
    // per-query in `query()` and merged into the dispatcher handler map.
    schemas.push(getRuntimeStateTool);
    // Custom (consumer-registered) tool schemas are appended last so their
    // names never silently shadow a builtin. A custom schema whose name
    // collides with an already-present builtin (or an earlier custom tool) is
    // SKIPPED: otherwise the wire `tools` array carries a duplicate name and
    // providers that require unique tool names reject the whole request. This
    // mirrors the handler-map precedence in buildDispatcher (builtins win).
    for (const t of opts.customTools ?? []) {
      if (!schemas.some((s) => s.name === t.schema.name)) schemas.push(t.schema);
    }
    // MCP tools are intentionally NOT pushed into `this.schemas` here.
    // Instead, `buildDispatcher()` serves them from `_mcpToolsCache` /
    // `_mcpHandlersCache`, which are populated on first use and invalidated by
    // `onToolsRefreshed` whenever `refreshServer()` or `completeAuth()` mutates
    // the nameRegistry (Option A — see PR 3 design doc).  The callback is
    // subscribed below so that `notifications/tools/list_changed` refreshes are
    // picked up automatically without restarting the session.

    this.memoryStore = opts.memoryStore ?? new MemoryStore();
    this.externalTools = opts.tools;
    this.skillExecutor = opts.skillExecutor;
    this.schemas = schemas;
    this.hookRegistry = opts.hookRegistry;
    this.permissions = opts.permissions;
    this.canUseTool = opts.canUseTool;
    this.subagentExecutor = opts.subagentExecutor;
    this.composeExecutor = opts.composeExecutor;
    this.surface = opts.surface ?? 'cli';
    this.readOnlyMemory = opts.readOnlyMemory === true;
    this.readOnlyBash = opts.readOnlyBash === true;
    this.customTools = opts.customTools ?? [];
    this.mcpManager = opts.mcpManager;
    if (opts.mcpManager) {
      // Subscribe to the refresh hook to invalidate the MCP tool/handler caches.
      // Chain through any pre-existing callback so we don't clobber an external
      // observer that may have been set before the provider was constructed.
      const existingRefreshCb = opts.mcpManager.onToolsRefreshed;
      opts.mcpManager.onToolsRefreshed = (serverName) => {
        this._mcpToolsCache = null;
        this._mcpHandlersCache = null;
        existingRefreshCb?.(serverName);
      };
    }
    if (opts.clientFactory) {
      this.providerFactory = opts.clientFactory;
    }
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
  private buildDispatcher(
    permissionMode: string,
    opts?: {
      cwd?: string;
      readRoots?: string[];
      writeRoots?: string[];
      env?: Record<string, string>;
      sessionId?: string;
      parentSessionId?: string;
      traceWriter?: TraceWriter;
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
       * instead, so falling back to `this.hookRegistry` when this is unset
       * preserves any constructor-provided registry.
       */
      hookRegistry?: import('../../hooks.js').HookRegistry;
      /**
       * Session-control bridge for the model-callable `exit_plan_mode` tool,
       * forwarded from the query config (top-level sessions only). When set AND
       * `permissionMode === 'plan'`, the handler + schema are registered.
       */
      planExitControls?: PlanExitControls;
    },
  ): SessionToolDispatcher {
    const handlers = createBuiltinHandlers(permissionMode, opts?.cwd);
    const memoryHandlers = createMemoryHandlers(
      this.memoryStore,
      undefined,
      this.surface,
    );
    // Read-only memory: register `memory_search` only. The dispatcher's
    // unknown-tool path produces a clear error if the model attempts
    // `memory_update` / `procedure_write` despite the schema being absent.
    for (const [name, handler] of memoryHandlers) {
      if (this.readOnlyMemory && name !== 'memory_search') continue;
      handlers.set(name, handler);
    }
    if (opts?.runtimeStateSource) {
      handlers.set('get_runtime_state', createGetRuntimeStateHandler(opts.runtimeStateSource));
    }
    // Invariant: custom (consumer-registered) handlers are registered AFTER
    // all builtins and the runtime-state handler, and BEFORE MCP handlers.
    // If a custom tool name collides with a builtin already in `handlers`,
    // the builtin wins (we skip the custom registration). This prevents a
    // user-supplied tool from silently overriding a built-in capability.
    // Location: src/agent/providers/anthropic-direct/index.ts buildDispatcher.
    for (const t of this.customTools) {
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
    if (this.mcpManager) {
      if (!this._mcpToolsCache) {
        this._mcpToolsCache = this.mcpManager.getMcpTools();
      }
      if (!this._mcpHandlersCache) {
        this._mcpHandlersCache = this.mcpManager.getMcpHandlers();
      }
      for (const [name, handler] of this._mcpHandlersCache) {
        handlers.set(name, handler);
      }
    }
    const mcpSchemas = this._mcpToolsCache ?? [];
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
      sessionGrantManager: this,
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
        ...this.schemas,
        ...mcpSchemas,
        ...(planExitControls ? [exitPlanModeTool] : []),
      ],
      // Session hook registry via the one canonical resolver (query-scoped
      // config registry wins over any constructor-provided one). Without this
      // the plan-mode gate (the sole built-in PreToolUse hook) never reached
      // the dispatcher and write tools ran unblocked in plan mode (c6892c6).
      hookRegistry: resolveSessionHookRegistry(opts?.hookRegistry, this.hookRegistry),
      // Union live MCP wire-names AND consumer-registered custom-tool names into
      // the (statically-snapshotted) allowlist so neither is rejected by the
      // gate while present in `schemas`/`handlers`. No-op when there is no
      // allowlist (undefined => all allowed) or nothing to union. Registering a
      // custom tool is the grant (same as connecting an MCP server); restricted
      // sub-agents carry no customTools, so this never widens their allowlist.
      permissions: withCustomToolsAllowed(
        this.mcpManager
          ? withMcpToolsAllowed(this.permissions, this.mcpManager.getMcpToolWireNames())
          : this.permissions,
        this.customTools.map((t) => t.schema.name),
      ),
      subagentExecutor: this.subagentExecutor,
      skillExecutor: this.skillExecutor,
      composeExecutor: this.composeExecutor,
      // In-process permission callback (Dim 8). No-op when unset; forwarded by
      // reference so it composes with the static allowlist in the dispatcher.
      ...(this.canUseTool !== undefined ? { canUseTool: this.canUseTool } : {}),
      cwd: opts?.cwd,
      readRoots: opts?.readRoots,
      writeRoots: opts?.writeRoots,
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
      sessionId: opts?.sessionId,
      parentSessionId: opts?.parentSessionId,
      ...(opts?.traceWriter ? { traceWriter: opts.traceWriter } : {}),
      // Read-only-skill bash gate: forwarded from the provider's stored flag
      // (set by createChildProviderFactory / buildReadOnlyReconProvider) so a
      // read-only skill's forked child can't run mutating shell commands.
      readOnlyBash: this.readOnlyBash,
    });
  }

  close(): void {
    this.memoryStore.close();
  }

  /**
   * Single-shot completion (see {@link ModelProvider.complete}). Resolves the
   * token with the same precedence as {@link query} — explicit `apiKey`, then
   * `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN` — so a Claude
   * subscription works without the caller re-resolving credentials.
   *
   * Local-shim baseURL is intentionally NOT plumbed here: side-channel
   * completions target the real Anthropic endpoint via `oneShotCompletion`,
   * which is OAuth-aware and resolves short aliases (`haiku`) through MODEL_MAP.
   * Local-model suggestions go through the openai-compatible provider instead.
   */
  async complete(args: ProviderCompleteArgs): Promise<string> {
    const token =
      args.apiKey && args.apiKey.length > 0
        ? args.apiKey
        : env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!token) {
      throw new Error(
        `${PROVIDER_NAME} complete() requires an API key or OAuth token ` +
          `(config apiKey, ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN)`,
      );
    }
    const input: OneShotInput = {
      token,
      model: args.model ?? DEFAULT_MODEL,
      system: args.system,
      user: args.user,
      maxTokens: args.maxTokens ?? 64,
    };
    if (args.signal) input.signal = args.signal;
    // Forward whichever client factory is active so test stubs intercept the
    // call. The provider factory accepts an extra `baseURL` field that
    // oneShotCompletion never sets — structurally compatible, hence the cast.
    const factory = this.providerFactory ?? clientFactory;
    if (factory) input.clientFactory = factory as OneShotInput['clientFactory'];
    return oneShotCompletion(input);
  }

  // ---------------------------------------------------------------------------
  // GrantManager interface — used by /allow-dir slash command
  // ---------------------------------------------------------------------------

  /**
   * Lazily initialise the shared root arrays if `query()` has not yet been
   * called (e.g. when /allow-dir runs before the first turn).
   */
  private ensureSharedRoots(cwd?: string): void {
    if (!this._sharedReadRoots) {
      const defaultRoots = cwd ? [cwd] : [];
      this._sharedReadRoots = defaultRoots.slice();
      this._sharedWriteRoots = defaultRoots.slice();
      // Capture the first non-empty cwd as the non-revocable resolveBase.
      // Mirrors SessionToolDispatcher's resolveBase guard so /allow-dir can't
      // strip containment from the session's original working directory.
      if (cwd && !this._initialResolveBase) {
        this._initialResolveBase = cwd;
      }
      // Track the current cwd for in-place migration on subsequent
      // `cwdDependentsFactory` calls (worktree rename / setCwd path).
      if (cwd && !this._currentCwd) {
        this._currentCwd = cwd;
      }
    }
  }

  /**
   * Shared grant-state machine (issues #361/#362). Hooks bind provider
   * semantics: lazy `ensureSharedRoots` init, the session's INITIAL
   * resolveBase as the non-revocable anchor (fixed across worktree renames),
   * `allowAll` derived from the current permission mode, and per-call
   * sessionId threading (no construction-bound default). See
   * grant-manager.ts for the divergence catalogue.
   */
  private readonly grantManager = new PathGrantManager({
    getReadRoots: () => this._sharedReadRoots,
    getWriteRoots: () => this._sharedWriteRoots,
    ensureInitialized: () => this.ensureSharedRoots(),
    getProtectedRoot: () => this._initialResolveBase,
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

  query(args: ProviderQueryArgs): ProviderQuery {
    const config = args.config;
    const { localMode, token } = resolveQueryToken(config);
    if (!token || token.length === 0) {
      throw new Error(
        `${PROVIDER_NAME} provider requires config.apiKey (resolved from ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)`,
      );
    }
    const authMode = detectAuthMode(token);
    // Live-throttle mailbox: the wrapped fetch pushes a signal onto this queue
    // for every 429/503/529 the SDK sleep-and-retries INSIDE a single
    // `messages.create`; the per-turn loop drains it to surface a `rate_limit`
    // ProviderEvent LIVE (the loop is otherwise parked awaiting the SDK and
    // cannot yield during the backoff). Installed only when the tracing fetch
    // is (non-local-shim + a trace writer OR a live surface would consume it) —
    // here it rides alongside the existing trace-writer gate so the queue and
    // the wrapper share the same lifetime. The SAME instance is handed to the
    // query below so the fetch producer and the loop consumer meet.
    const throttleQueue =
      !localMode && config.traceWriter ? new ThrottleQueue() : undefined;
    const clientOpts = buildClientOptions(
      token,
      authMode,
      config.baseUrl,
      // Observability: route SDK HTTP through a wrapper that (1) records
      // 429/503/529 throttling into the witness trace so the SDK's
      // otherwise-silent retry-after backoff is legible in `afk trace show`,
      // and (2) pushes a live signal onto `throttleQueue` so the progress
      // banner can show the backoff as it happens. Skipped in local-shim mode
      // (not Anthropic's billing surface) and when no trace writer is attached.
      !localMode && config.traceWriter
        ? makeTracingFetch(
            config.traceWriter,
            undefined,
            throttleQueue ? (info) => throttleQueue.push(info) : undefined,
          )
        : undefined,
    );
    const factory = this.providerFactory ?? clientFactory;
    const client = factory ? factory(clientOpts) : new Anthropic(clientOpts);
    // In local-server mode, suppress the OAuth CLI-mimicry system-prefix
    // regardless of token shape: the shim is not Anthropic's billing surface
    // and should not receive Claude-Code identity headers in the system prompt.
    const systemPrefix = localMode ? null : buildSystemPrefix(authMode);
    const userSystem = resolveUserSystem(config.systemPrompt);

    const model =
      typeof config.model === 'string' && config.model.length > 0
        ? (resolveModelId(config.model) ?? config.model)
        : DEFAULT_MODEL;

    const maxTokens = resolveMaxTokens(config, model);

    // Build a per-query dispatcher closed over the session's permissionMode
    // and cwd (fixes C2 env race + the process.cwd() leak: concurrent
    // sessions in different worktrees would otherwise all spawn bash/grep
    // against the host's process.cwd()). When the caller injected an
    // external dispatcher, use it as-is — external callers own their own
    // lifecycle.
    const permissionMode = config.permissionMode ?? 'default';
    // Track for getGrants() so the path-approval hook's allowAll stays in sync
    // with the per-query dispatcher's (both derive from this mode).
    this._currentPermissionMode = permissionMode;

    // Initialise the shared root arrays on first query. Subsequent queries
    // reuse the same array references so /allow-dir grants survive across turns.
    // Route through ensureSharedRoots so _initialResolveBase is captured for
    // the non-revocable guard in revokeRoot.
    this.ensureSharedRoots(config.cwd);
    // If the caller pre-supplied roots (e.g. forked subagent), prefer them on
    // the very first init only — ensureSharedRoots will have created defaults
    // we now overwrite with the explicit values.
    if (config.readRoots && this._sharedReadRoots && this._sharedReadRoots.length <= 1) {
      this._sharedReadRoots.length = 0;
      this._sharedReadRoots.push(...config.readRoots);
    }
    if (config.writeRoots && this._sharedWriteRoots && this._sharedWriteRoots.length <= 1) {
      this._sharedWriteRoots.length = 0;
      this._sharedWriteRoots.push(...config.writeRoots);
    }

    // Awareness layer source: declared as a `let` because the dispatcher and
    // the source have a benign cycle — `getEnabledToolNames` resolves through
    // a closure that reads `queryDispatcher` lazily at handler-call time, so
    // the assignment-before-use ordering below is safe.
    let queryDispatcher: import('./tool-dispatcher.js').ToolDispatcher;

    const runtimeStateSource: RuntimeStateSource = buildRuntimeStateSource({
      surface: this.surface,
      cwd: config.cwd ?? process.cwd(),
      modelName: model,
      providerName: PROVIDER_NAME,
      permissionMode,
      ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
      ...(config.parentSessionId !== undefined
        ? { parentSessionId: config.parentSessionId }
        : {}),
      ...(config.depth !== undefined ? { depth: config.depth } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
      ...(config.phaseRole !== undefined ? { phaseRole: config.phaseRole } : {}),
      getEnabledToolNames: () =>
        queryDispatcher instanceof SessionToolDispatcher
          ? queryDispatcher.toolDefs.map((t) => t.name)
          : [],
      getMcpTools: () => this.mcpManager?.getMcpTools() ?? [],
      getSubagents: () =>
        this.subagentExecutor
          ? this.subagentExecutor.getSubagentsLite()
          : { active: [], backgroundJobs: [] },
    });

    this._presenceSessionId = registerPresenceLifecycle({
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      sessionId: config.sessionId,
      currentPresenceSessionId: this._presenceSessionId,
      runtimeStateSource,
      surface: this.surface,
      cwd: config.cwd,
      providerName: PROVIDER_NAME,
      model,
    });

    queryDispatcher = this.externalTools
      ? wrapDispatcherWithRuntimeState(this.externalTools, runtimeStateSource)
      : this.buildDispatcher(permissionMode, {
          cwd: config.cwd,
          readRoots: this._sharedReadRoots,
          writeRoots: this._sharedWriteRoots,
          ...(config.env !== undefined ? { env: config.env } : {}),
          sessionId: config.sessionId,
          parentSessionId: config.parentSessionId,
          traceWriter: config.traceWriter,
          runtimeStateSource,
          hookRegistry: config.hookRegistry,
          planExitControls: config.planExitControls,
        });

    // External-dispatcher branch: the caller owns routing for whatever tools
    // it cares about, but we still offer `get_runtime_state` because the
    // wrapper above intercepts it before it ever reaches the inner dispatcher.
    // Without adding the schema here the model has no way to know the tool
    // exists — leaving the awareness layer reachable only via the
    // `SessionToolDispatcher` path.
    const baseToolDefs = queryDispatcher instanceof SessionToolDispatcher
      ? [...queryDispatcher.toolDefs]
      : [...builtinToolSchemas, getRuntimeStateTool];
    // Invariant: skill-dispatch sub-agents are dispatched AS a specific skill, so
    // they must neither (a) pause to ask the operator "which skill?" nor (b) mutate
    // the operator's environment. Strip `ask_question` (the operator-prompt escape
    // hatch) and `terminal_font_size` (an environment tool with no role in skill
    // work — a bare numeric skill arg such as a PR number can otherwise lure a
    // confused model into calling terminal_font_size(<n>) instead of running the
    // skill). Gated on isSkillDispatch; pairs with the SLASH_COMMAND_ROUTING_PROMPT
    // omission below. Verified safe: no bundled/registry/user skill calls either tool.
    // Non-interactive surfaces (daemon, scheduler/cron, one-shot `afk chat`)
    // install no elicitation handler, so `ask_question` can only auto-decline
    // (elicitation-router.ts). Strip it so the model proceeds on an assumption
    // or emits Blocked rather than burning a turn on an unanswerable prompt.
    // Narrower than the skill-dispatch strip: `terminal_font_size` is retained.
    const toolDefs = config.isSkillDispatch
      ? baseToolDefs.filter(
          (t) => t.name !== 'ask_question' && t.name !== 'terminal_font_size',
        )
      : config.isNonInteractive
        ? baseToolDefs.filter((t) => t.name !== 'ask_question')
        : baseToolDefs;

    const cwd = config.cwd || process.cwd();

    // Build skill manifest for system prompt injection. The manifest lists
    // available skills so the model knows what the `skill` tool can invoke.
    // Let collectSkillEntries() own the full scan (project + user + bundled).
    // Pass the session cwd so project skills (<cwd>/.afk/skills/) resolve
    // against the session's working directory, not the host process's —
    // they diverge on long-lived hosts (daemon, Telegram bot).
    const manifest = this.skillExecutor
      ? buildSkillManifest(undefined, { cwd })
      : '';
    // Invariant: SLASH_COMMAND_ROUTING_PROMPT is omitted for skill-dispatch
    // sub-agents. Those sessions receive a "Run the <name> skill" directive
    // with no <command-name> tag, so the routing instruction (which keys off
    // that tag) would push them to ask "which skill?" instead of engaging with
    // their SKILL.md body. The ask_question strip above is the structural
    // backstop for the same failure mode.
    const toolBase = resolveToolSystemPrompt(config.isSkillDispatch);
    // Read-only memory child sessions get a slimmed prompt that omits write
    // instructions for memory_update / procedure_write — keeps the model from
    // being told about tools it does not have.
    const memoryPrompt = resolveMemorySystemPrompt(this.readOnlyMemory);

    // Awareness identity fields interleaved into the `# Environment` fragment
    // (Phase 1 + 2). Stable across cwd swaps — only `cwd` changes on setCwd().
    const environmentIdentity = {
      surface: this.surface,
      sessionId: config.sessionId,
      depth: config.depth,
      maxDepth: config.maxDepth,
      workspace: runtimeStateSource.getWorkspace(),
    };

    // Stable (cwd-independent) parts of the system prompt. The cwd-dependent
    // `# Environment` fragment is spliced in by assembleSystemPrompt — the same
    // helper the cwdDependentsFactory below uses on a cwd change, so the
    // first-turn and rebuilt prompts can never drift.
    const stableSystemPrefix = buildStableSystemPrefix({
      toolBase,
      memoryPrompt,
      // Hot memory (HOT.md) rides its own config field, NOT prepended into
      // systemPrompt, so the assembler can place it after the memory
      // instructions rather than ahead of the # Agent AFK doctrine. Unset for
      // child sessions (subagents never inject hot memory) → treated as absent.
      hotMemory: config.hotMemory ?? '',
      manifest,
      userSystem,
    });
    const toolSystemAppend = assembleSystemPrompt(stableSystemPrefix, cwd, environmentIdentity);

    // Dump prompt debug info if AFK_DUMP_PROMPT is set (wired via --dump-prompt CLI flag).
    dumpIfEnabled({
      prompt: args.prompt,
      options: { model, maxTokens, system: toolSystemAppend },
      provenance: {
        systemPrompt: {
          source: config.systemPromptSource ?? 'none',
          shape: typeof config.systemPrompt === 'string'
            ? 'string'
            : Array.isArray(config.systemPrompt)
              ? 'string[]'
              : config.systemPrompt != null
                ? 'preset'
                : 'undefined',
          ...(typeof config.systemPrompt === 'string'
            ? { length: config.systemPrompt.length }
            : {}),
        },
        ...(config.apiKey ? { apiKey: { source: 'config' } } : {}),
      },
    });

    let tokenRefresher: (() => Promise<Anthropic | null>) | undefined;
    // In local-server mode, never refresh the keychain OAuth token: a 401 from
    // the local shim must not cause the SDK to fetch and forward a real
    // Anthropic credential to a self-hosted endpoint. The placeholder token
    // path above already prevents this on the initial request; this guard
    // closes the 401-retry hole.
    if (authMode === 'oauth' && !localMode) {
      const factory = this.providerFactory ?? clientFactory;
      tokenRefresher = async (): Promise<Anthropic | null> => {
        const freshToken = await refreshClaudeCodeOauthToken();
        if (!freshToken) return null;
        const opts = buildClientOptions(
          freshToken,
          'oauth',
          config.baseUrl,
          // Preserve throttle observability AND the live-banner signal across an
          // OAuth account swap — the rebuilt client must keep the same
          // tracing-fetch wrapper wired to the same `throttleQueue`. localMode
          // is false in this branch (see the guard above).
          config.traceWriter
            ? makeTracingFetch(
                config.traceWriter,
                undefined,
                throttleQueue ? (info) => throttleQueue.push(info) : undefined,
              )
            : undefined,
        );
        return factory ? factory(opts) : new Anthropic(opts);
      };
    }

    const resumedSessionId = config.sessionId ?? config.resume;
    const initialMessages = resumeHistoryToMessages(config.resumeHistory);

    const cwdDependentsFactory = this.externalTools
      ? undefined
      : createCwdDependentsFactory({
          stableSystemPrefix,
          config,
          surface: this.surface,
          runtimeStateSource,
          getCurrentCwd: () => this._currentCwd,
          setCurrentCwd: (newCwd) => { this._currentCwd = newCwd; },
          getCurrentPermissionMode: () => this._currentPermissionMode,
          sharedReadRoots: this._sharedReadRoots,
          sharedWriteRoots: this._sharedWriteRoots,
          subagentExecutor: this.subagentExecutor,
          skillExecutor: this.skillExecutor,
          composeExecutor: this.composeExecutor,
          buildDispatcher: (mode, opts) => this.buildDispatcher(mode, opts),
        });

    const resolvedEffort = resolveEffort(config.effort, model);
    return new AnthropicDirectQuery({
      client,
      // In local-server mode, downgrade the effective auth mode to 'api-key'
      // so that per-request OAuth CLI-mimicry headers (anthropic-beta, x-app,
      // User-Agent, X-Claude-Code-Session-Id) are never sent to the shim.
      // The real authMode is still used above for client construction and
      // tokenRefresher — only the per-turn header emission is suppressed.
      authMode: localMode ? 'api-key' : authMode,
      promptStream: args.prompt,
      toolDispatcher: queryDispatcher,
      ...(resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {}),
      ...(initialMessages !== undefined ? { initialMessages } : {}),
      model,
      // Preserve the requested alias (e.g. opus_1m) so context-window lookups
      // recover the 1M window. `model` above is the resolved wire id, which is
      // ambiguous between an alias and its 1M variant. Fall back to the wire id
      // when no distinct alias was supplied.
      requestedModel:
        typeof config.model === 'string' && config.model.length > 0 ? config.model : model,
      ...(config.permissionMode !== undefined
        ? { permissionMode: config.permissionMode }
        : {}),
      maxTokens,
      tools: toolDefs,
      userSystem: toolSystemAppend,
      systemPrefix,
      tokenRefresher,
      ...(config.thinking !== undefined
        ? { thinking: resolveThinkingParam(config.thinking, maxTokens, model) }
        : {}),
      ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      ...(localMode ? { baseUrl: config.baseUrl } : {}),
      ...(config.traceWriter ? { traceWriter: config.traceWriter } : {}),
      ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
      ...(config.autoResumeOnUsageLimit !== undefined
        ? { autoResumeOnUsageLimit: config.autoResumeOnUsageLimit }
        : {}),
      ...(config.maxToolUseIterations !== undefined
        ? { maxToolUseIterations: config.maxToolUseIterations }
        : {}),
      ...(cwdDependentsFactory !== undefined ? { cwdDependentsFactory } : {}),
      // Path-approval half of the live `/bypass` toggle: keep the provider's
      // `_currentPermissionMode` (read by getGrants().allowAll) in sync with
      // the query handle's mode. The file-tool half is the dispatcher's
      // setAllowAll(), flipped inside the same setPermissionMode call.
      onPermissionMode: (mode: string) => {
        this._currentPermissionMode = mode;
      },
      ...(this.mcpManager !== undefined ? { mcpManager: this.mcpManager } : {}),
      ...(resolveAutoCompactThreshold(config.autoCompact) !== undefined
        ? { autoCompactThreshold: resolveAutoCompactThreshold(config.autoCompact) }
        : {}),
      // Thread the resolved hook registry into the query so auto-compaction
      // can dispatch PreCompact(trigger:'auto') before calling compact().
      // resolveSessionHookRegistry is already called above for the dispatcher;
      // we reuse config.hookRegistry directly here — the query stores it
      // separately from the dispatcher and dispatches only PreCompact events.
      ...(config.hookRegistry !== undefined ? { hookRegistry: config.hookRegistry } : {}),
      // Live-throttle mailbox: the SAME instance wired to the client fetch
      // callback above, so the loop's consumer meets the fetch producer.
      ...(throttleQueue !== undefined ? { throttleQueue } : {}),
    });
  }
}

/**
 * Resolve the user-supplied system prompt to a plain string.
 *
 * - `string` → returned as-is when non-empty.
 * - `{ type: 'preset', preset: 'claude_code', append?: string }` → the preset
 *   itself has no analog on the direct path, so we drop it and forward only
 *   the `append` portion (the user's explicit additions).
 * - everything else → `null`.
 */
function resolveUserSystem(sp: AgentConfig['systemPrompt']): string | null {
  if (sp === undefined) return null;
  if (typeof sp === 'string') return sp.length > 0 ? sp : null;
  if (typeof sp === 'object' && sp !== null && 'append' in sp) {
    const append = (sp as { append?: string }).append;
    return append && append.length > 0 ? append : null;
  }
  return null;
}

/**
 * Module-scope default instance, retained as a stable export for callers that
 * want a quick handle (tests, direct imports). NOT used by `resolveProvider()`
 * — the router constructs a fresh provider per session to avoid cross-session
 * leakage of the shared root arrays under `afk farm new N` parallel dispatch.
 * See `providers/index.ts:resolveProvider` and the per-session isolation note
 * on the {@link AnthropicDirectProvider} class.
 */
export const anthropicDirectProvider: ModelProvider = new AnthropicDirectProvider();
