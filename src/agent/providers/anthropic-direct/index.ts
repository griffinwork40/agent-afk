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
import { parseQuotaHeaders, recordQuotaSnapshot } from '../../quota-cache.js';
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
import {
  buildDispatcher as buildDispatcherImpl,
  type BuildDispatcherOptions,
} from './build-dispatcher.js';
import {
  __setAnthropicClientFactory,
  getClientFactory,
  type AnthropicClientFactory,
  type AnthropicDirectProviderOptions,
} from './provider-options.js';
// Re-exported so the historical `from './index.js'` import paths stay valid
// after the #824 split (both are load-bearing for the existing test suite).
export {
  __setAnthropicClientFactory,
  type AnthropicClientFactory,
  type AnthropicDirectProviderOptions,
} from './provider-options.js';
import { builtinToolSchemas, agentTool, skillTool, composeTool } from '../../tools/schemas.js';
import { resolveToolSystemPrompt, resolveMemorySystemPrompt } from '../../tools/system-prompt.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { buildSkillManifest } from '../../tools/skill-bridge.js';
import { MemoryStore, memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import { dumpIfEnabled } from '../../session/prompt-dump.js';
import { env } from '../../../config/env.js';
import { resolveQueryToken } from './query/token-resolution.js';
import {
  getRuntimeStateTool,
  wrapDispatcherWithRuntimeState,
  buildRuntimeStateSource,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { registerPresenceLifecycle, resolveTopLevelSessionId } from './query/presence-lifecycle.js';
import { createCwdDependentsFactory } from './query/cwd-dependents.js';
import { assembleSystemPrompt, buildStableSystemPrefix } from './query/system-prompt.js';

const PROVIDER_NAME = 'anthropic-direct';
const DEFAULT_MODEL = 'claude-sonnet-5';

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
  /**
   * Contract: the surface as DECLARED by the constructor caller — `undefined`
   * when none was passed. Distinct from {@link surface}, which defaults to
   * 'cli' because presence advertising mints only for 'cli' and a
   * default-constructed provider must still advertise (pinned by
   * `presence-advertise.test.ts` / `presence-lifecycle.test.ts`). Consumers
   * that must NOT read an unstated surface as interactive use this instead.
   * The overload pause is one (#762/#764): every forked child is constructed
   * with no surface, so the 'cli' default would hand headless children the
   * 10-minute interactive park that fix exists to deny them.
   */
  private readonly declaredSurface: string | undefined;
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

  /**
   * Session id minted for a top-level session that supplied none (no --resume).
   * Memoized so it stays stable across turns — `query()` runs once per turn, and
   * a fresh mint each turn would move the ledger directory out from under the
   * presence file the Telegram watcher is already following.
   *
   * `null` = nothing minted yet (either not top-level, or an explicit id won).
   */
  private _mintedSessionId: string | null = null;

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
    // Invariant: the default must be a NON-interactive surface. Every forked
    // child's provider is constructed without `surface` (tools/nesting.ts and
    // providers/index.ts pass only permissions/executors), and this value is
    // what gates the overload pause (`resolveOverloadPauseCeilingMs` via
    // index.ts → query.ts → retry-layer.ts). Defaulting to 'cli' gave headless
    // children the 10-minute interactive park the #762 fix exists to deny them.
    // Top-level entrypoints all pass `surface` explicitly (chat/bootstrap
    // 'cli', daemon 'daemon', telegram 'telegram'), so only fork paths and the
    // unused module singleton observe this default.
    this.surface = opts.surface ?? 'cli';
    this.declaredSurface = opts.surface;
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
   * Build a per-query tool dispatcher. Delegates to the extracted
   * {@link buildDispatcherImpl} (#824), supplying the provider-scoped
   * collaborators it used to read off `this`. The two MCP caches are passed as
   * accessor pairs so the fields stay owned here and `onToolsRefreshed`
   * invalidation keeps working.
   */
  private buildDispatcher(
    permissionMode: string,
    opts?: BuildDispatcherOptions,
  ): SessionToolDispatcher {
    return buildDispatcherImpl(
      {
        memoryStore: this.memoryStore,
        surface: this.surface,
        readOnlyMemory: this.readOnlyMemory,
        readOnlyBash: this.readOnlyBash,
        customTools: this.customTools,
        mcpManager: this.mcpManager,
        schemas: this.schemas,
        hookRegistry: this.hookRegistry,
        permissions: this.permissions,
        canUseTool: this.canUseTool,
        subagentExecutor: this.subagentExecutor,
        skillExecutor: this.skillExecutor,
        composeExecutor: this.composeExecutor,
        sessionGrantManager: this,
        getMcpToolsCache: () => this._mcpToolsCache,
        setMcpToolsCache: (v) => { this._mcpToolsCache = v; },
        getMcpHandlersCache: () => this._mcpHandlersCache,
        setMcpHandlersCache: (v) => { this._mcpHandlersCache = v; },
      },
      permissionMode,
      opts,
    );
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
    const factory = this.providerFactory ?? getClientFactory();
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
    // Invariant: quota capture is gated on `!localMode` ALONE — deliberately not
    // on `config.traceWriter`. The `anthropic-ratelimit-unified-*` headers ride
    // on every response and feed the CLI status line, which must stay live even
    // when tracing is off (`AFK_TRACE_DISABLED=1`); tying it to the trace writer
    // would silently blank the indicator in that configuration. localMode is
    // still excluded: a local shim is not Anthropic and emits no quota headers.
    const quotaObserver = localMode
      ? undefined
      : (headers: Headers): void => {
          const snapshot = parseQuotaHeaders(headers);
          if (snapshot !== undefined) recordQuotaSnapshot(snapshot);
        };
    const clientOpts = buildClientOptions(
      token,
      authMode,
      config.baseUrl,
      // Observability: route SDK HTTP through a wrapper that (1) records
      // 429/503/529 throttling into the witness trace so the SDK's
      // otherwise-silent retry-after backoff is legible in `afk trace show`,
      // (2) pushes a live signal onto `throttleQueue` so the progress banner can
      // show the backoff as it happens, and (3) captures subscription-quota
      // headers into the quota cache for the status line. Skipped entirely in
      // local-shim mode (not Anthropic's billing surface). Note the wrapper is
      // installed whenever ANY of the three observers is live — a trace writer
      // is no longer required, since (3) must work with tracing disabled.
      !localMode
        ? makeTracingFetch(
            config.traceWriter,
            undefined,
            throttleQueue ? (info) => throttleQueue.push(info) : undefined,
            quotaObserver,
          )
        : undefined,
    );
    const factory = this.providerFactory ?? getClientFactory();
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

    // Invariant: presence and query construction MUST use the same session id,
    // because the Telegram watcher resolves a session's ledger path from the id
    // in its presence file. Resolve once here — BEFORE the presence write — and
    // reuse the result for `new AnthropicDirectQuery` below, so the presence
    // file, the `session.init` event, and the ledger directory cannot diverge.
    // Reading `config.sessionId` alone is what broke this: it is set only under
    // --resume, so fresh sessions advertised nothing at all.
    const resolvedSession = resolveTopLevelSessionId({
      sessionId: config.sessionId,
      resume: config.resume,
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      surface: this.surface,
      memoized: this._mintedSessionId,
    });
    this._mintedSessionId = resolvedSession.memoized;

    this._presenceSessionId = registerPresenceLifecycle({
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      sessionId: resolvedSession.id,
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
          ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
          // Fork-scoped central output cap (#661): forwarded from the child
          // config that forkSubagent stamped, arming maxOutputBytes for forks
          // only (top-level leaves it unset).
          ...(config.subagentToolOutputCapBytes !== undefined
            ? { subagentToolOutputCapBytes: config.subagentToolOutputCapBytes }
            : {}),
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
    // `excludeName` omits the executing skill's own entry for a skill-dispatch
    // fork (see AgentConfig.skillDispatchName). Must stay in lockstep with the
    // openai-compatible call site — a per-provider divergence here is how a
    // fork on one provider silently keeps the self-entry.
    const manifest = this.skillExecutor
      ? buildSkillManifest(undefined, {
          cwd,
          ...(typeof config.skillDispatchName === 'string' &&
          config.skillDispatchName.length > 0
            ? { excludeName: config.skillDispatchName }
            : {}),
        })
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
      const factory = this.providerFactory ?? getClientFactory();
      tokenRefresher = async (): Promise<Anthropic | null> => {
        const freshToken = await refreshClaudeCodeOauthToken();
        if (!freshToken) return null;
        const opts = buildClientOptions(
          freshToken,
          'oauth',
          config.baseUrl,
          // Preserve throttle observability, the live-banner signal AND quota
          // capture across an OAuth account swap — the rebuilt client must keep
          // the same tracing-fetch wrapper wired to the same `throttleQueue` and
          // the same quota observer. localMode is false in this branch (see the
          // guard above), so `quotaObserver` is always defined here and the
          // wrapper installs unconditionally — no trace-writer gate, matching
          // the primary install site above.
          makeTracingFetch(
            config.traceWriter,
            undefined,
            throttleQueue ? (info) => throttleQueue.push(info) : undefined,
            quotaObserver,
          ),
        );
        return factory ? factory(opts) : new Anthropic(opts);
      };
    }

    // Invariant: this MUST be the same id the presence file advertises, so the
    // Telegram watcher tails the ledger this session actually writes. Sourced
    // from the single resolution performed above (explicit --resume id wins;
    // top-level sessions get a memoized mint; forks stay undefined so the query
    // keeps minting its own id per call). `opts.sessionId` feeds only
    // `initSessionId` in query.ts — it gates no resume behavior — so supplying
    // a minted id here is inert apart from making the id known earlier.
    const resumedSessionId = resolvedSession.id;
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
      // Overload-pause surface gate (#762): reuse the EXISTING surface signal
      // (the same value stamped as `origin` on session_init_start) rather than
      // inventing a new one, so a daemon session fails fast on upstream capacity
      // while an interactive one may park briefly.
      //
      // Invariant: this reads `declaredSurface`, NEVER `surface`. `surface`
      // defaults to 'cli' for presence advertising, and every forked child is
      // constructed with no surface at all — so reading it would grant headless
      // children the interactive park this gate exists to deny them (#764).
      // `resolveOverloadPauseCeilingMs(undefined)` already means "fail fast".
      surface: this.declaredSurface,
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
