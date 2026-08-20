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
 * per-session mutable state (the shared root arrays and resolve base owned by
 * {@link ProviderGrantState}) isolated across concurrent `AgentSession`s — see
 * `providers/index.ts:resolveProvider` for the rationale. Callers may also
 * inject a pre-built instance via `AgentConfig.provider`.
 *
 * # Structure
 *
 * This file owns the class: its fields, the per-session mutable state, and the
 * grant-manager surface. The heavy pipelines live in siblings and receive a
 * {@link ProviderQueryContext} of live accessors, because a TypeScript class
 * cannot be physically continued across modules:
 *   - `provider-schemas.ts`      — static tool-schema assembly
 *   - `provider-query-setup.ts`  — credentials, model, dispatcher, prompt
 *   - `provider-query-build.ts`  — factories + `AnthropicDirectQuery` construction
 *
 * @module agent/providers/anthropic-direct
 */

import type { CanUseTool } from '../../types/sdk-types.js';
import type {
  ModelProvider,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderCompleteArgs,
} from '../../provider.js';
import { oneShotCompletion, type OneShotInput } from './oneshot.js';
// Re-export the pure param resolvers extracted to ./resolve-params.ts (issue
// #103) so the historical `from './index.js'` import path stays valid.
export { resolveEffort, resolveMaxTokens, resolveThinkingParam } from './resolve-params.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { ProviderGrantState } from './provider-grants.js';
import {
  buildDispatcher as buildDispatcherImpl,
  type BuildDispatcherOptions,
} from './build-dispatcher.js';
import { getClientFactory, type AnthropicClientFactory, type AnthropicDirectProviderOptions } from './provider-options.js';
// Re-exported so the historical `from './index.js'` import paths stay valid
// after the #824 split (both are load-bearing for the existing test suite).
export {
  __setAnthropicClientFactory,
  type AnthropicClientFactory,
  type AnthropicDirectProviderOptions,
} from './provider-options.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import { MemoryStore } from '../../memory/index.js';
import { WorkspaceStore } from '../../workspace/workspace-store.js';
import { env } from '../../../config/env.js';
import { buildProviderSchemas } from './provider-schemas.js';
import type { ProviderQueryContext } from './provider-context.js';
import { setUpQuerySession } from './provider-query-setup.js';
import { buildProviderQuery } from './provider-query-build.js';
import { CLAUDE_SONNET_ID } from '../../session/model-slots.js';
// Re-exported so the historical import path stays valid after the split.
export { resolveUserSystem } from './provider-query-setup.js';

const PROVIDER_NAME = 'anthropic-direct';
// Contract: a query arriving with no model resolves to whatever the `sonnet`
// alias and the `medium` tier resolve to. Delegating to CLAUDE_SONNET_ID makes
// that structural rather than a hand-synced duplicate literal — bumping the
// default Sonnet is a one-line edit in session/model-slots.ts. Exported so
// provider-runtime.test.ts can pin the delegation against re-hardcoding.
export const DEFAULT_MODEL = CLAUDE_SONNET_ID;

/**
 * Direct Anthropic SDK provider. Construction is cheap; the real per-session
 * lifecycle starts on `query()`.
 */
export class AnthropicDirectProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  /** Non-null only when the caller provides an explicit `opts.tools` override. */
  private readonly externalTools: ToolDispatcher | undefined;
  private readonly memoryStore: MemoryStore;
  private readonly workspaceStore: WorkspaceStore | undefined;
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
  private readonly fastModeController?: import('../../fast-mode.js').FastModeController;
  /**
   * Per-session path-grant + cwd state (shared root arrays, non-revocable
   * resolve base, live cwd, permission mode). Extracted whole — see
   * `provider-grants.ts` for the sharing contract.
   */
  private readonly grants = new ProviderGrantState();
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
    this.memoryStore = opts.memoryStore ?? new MemoryStore();
    this.workspaceStore = opts.workspaceStore;
    this.externalTools = opts.tools;
    this.skillExecutor = opts.skillExecutor;
    this.schemas = buildProviderSchemas(opts);
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
    this.fastModeController = opts.fastModeController;
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
        workspaceStore: this.workspaceStore,
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
    this.workspaceStore?.close();
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

  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grants.manager.addReadRoot(absPath, source, sessionId);
  }

  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grants.manager.addWriteRoot(absPath, source, sessionId);
  }

  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grants.manager.revokeRoot(absPath, source, sessionId);
  }

  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[]; allowAll: boolean } {
    return this.grants.manager.getGrants();
  }

  /**
   * Live view handed to the extracted `query()` pipeline.
   *
   * Invariant: mutable session state is exposed as accessor pairs, never as
   * captured values — the shared-root arrays are shared BY REFERENCE with every
   * per-query dispatcher, which is how `/allow-dir` grants survive across turns.
   */
  private queryContext(): ProviderQueryContext {
    const provider = this;
    return {
      get externalTools() { return provider.externalTools; },
      get providerFactory() { return provider.providerFactory; },
      get skillExecutor() { return provider.skillExecutor; },
      get subagentExecutor() { return provider.subagentExecutor; },
      get composeExecutor() { return provider.composeExecutor; },
      get canUseTool() { return provider.canUseTool; },
      get surface() { return provider.surface; },
      get declaredSurface() { return provider.declaredSurface; },
      get readOnlyMemory() { return provider.readOnlyMemory; },
      get mcpManager() { return provider.mcpManager; },
      get fastModeController() { return provider.fastModeController; },
      getSharedReadRoots: () => provider.grants.readRoots,
      getSharedWriteRoots: () => provider.grants.writeRoots,
      getCurrentCwd: () => provider.grants.currentCwd,
      setCurrentCwd: (cwd) => { provider.grants.currentCwd = cwd; },
      getCurrentPermissionMode: () => provider.grants.permissionMode,
      setCurrentPermissionMode: (mode) => { provider.grants.permissionMode = mode; },
      getMintedSessionId: () => provider._mintedSessionId,
      setMintedSessionId: (v) => { provider._mintedSessionId = v; },
      getPresenceSessionId: () => provider._presenceSessionId,
      setPresenceSessionId: (v) => { provider._presenceSessionId = v; },
      ensureSharedRoots: (cwd) => { provider.grants.ensureInitialized(cwd); },
      buildDispatcher: (mode, opts) => provider.buildDispatcher(mode, opts),
    };
  }

  query(args: ProviderQueryArgs): ProviderQuery {
    const ctx = this.queryContext();
    const setup = setUpQuerySession(ctx, args, PROVIDER_NAME, DEFAULT_MODEL);
    return buildProviderQuery(ctx, args, setup);
  }
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
