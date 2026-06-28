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

import path from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getSessionGrantsPath } from '../../../paths.js';
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
import { withMcpToolsAllowed, withCustomToolsAllowed, type ToolPermissionConfig } from '../../tools/permissions.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { pathContainmentBypassed } from '../../permission-policy.js';
import { createBuiltinHandlers } from '../../tools/handlers/index.js';
import {
  exitPlanModeTool,
  createExitPlanModeHandler,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/handlers/exit-plan-mode.js';
import type { PlanExitControls } from '../../types/config-types.js';
import {
  builtinToolSchemas,
  agentTool,
  skillTool,
  composeTool,
} from '../../tools/schemas.js';
import { MemoryStore, createMemoryHandlers, memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import { buildQueryFromConfig } from './query.js';
import { oneShotChatCompletion, type OpenAIOneShotInput } from './oneshot.js';
import {
  getRuntimeStateTool,
  createGetRuntimeStateHandler,
  wrapDispatcherWithRuntimeState,
  buildRuntimeStateSource,
  formatEnvironmentFragment,
  writePresenceFile,
  removePresenceFileSync,
  type RuntimeStateSource,
} from '../../awareness/index.js';
import { actorFromDepth } from '../../session/session-identity.js';

const PROVIDER_NAME = 'openai-compatible';

/**
 * Construction options. The same surface anthropic-direct exposes — modulo
 * Anthropic-specific knobs (client factory, OAuth keychain) — so callers
 * can build either provider with the same dependency bundle.
 */
export interface OpenAICompatibleProviderOptions {
  /** Override the default `https://api.openai.com/v1` endpoint. */
  baseURL?: string;
  /** Hook registry — PreToolUse / PostToolUse fire from the dispatcher. */
  hookRegistry?: HookRegistry;
  /** Tool permission gate (allowlist/denylist). */
  permissions?: ToolPermissionConfig;
  subagentExecutor?: SubagentExecutor;
  skillExecutor?: SkillExecutor;
  composeExecutor?: ComposeExecutor;
  /** Shared memory store (avoids dual SQLite handles when CLI builds it once). */
  memoryStore?: MemoryStore;
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
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  private readonly providerOpts: OpenAICompatibleProviderOptions;
  private readonly memoryStore: MemoryStore;
  private readonly schemas: AnthropicToolDef[];

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
  private _initialResolveBase: string | undefined;
  /**
   * Presence-registration guard — same semantics as
   * `AnthropicDirectProvider._presenceSessionId`. `null` = not yet registered.
   */
  private _presenceSessionId: string | null = null;

  constructor(opts: OpenAICompatibleProviderOptions = {}) {
    this.providerOpts = opts;
    this.memoryStore = opts.memoryStore ?? new MemoryStore();

    const schemas: AnthropicToolDef[] = [...builtinToolSchemas];
    if (opts.subagentExecutor) schemas.push(agentTool);
    if (opts.skillExecutor) schemas.push(skillTool);
    if (opts.composeExecutor) schemas.push(composeTool);
    if (opts.readOnlyMemory === true) {
      schemas.push(memorySearchTool);
    } else {
      schemas.push(...memoryToolSchemas);
    }
    // Awareness layer (Phase 1) — parity with anthropic-direct. The
    // system-prompt identity fragment is NOT added here because the
    // openai-compatible message builder (messages.ts) does not currently
    // emit a `# Environment` block at all — extending it is Phase 2 work.
    // The `get_runtime_state` tool remains available so the model can
    // pull identity on demand.
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
    this.schemas = schemas;
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

    const runtimeStateSource: RuntimeStateSource = buildRuntimeStateSource({
      surface: this.providerOpts.surface ?? 'cli',
      cwd: config.cwd ?? process.cwd(),
      modelName,
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
        dispatcher instanceof SessionToolDispatcher
          ? dispatcher.toolDefs.map((t) => t.name)
          : [],
      getMcpTools: () => this.providerOpts.mcpManager?.getMcpTools() ?? [],
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
    dispatcher = this.providerOpts.tools
      ? wrapDispatcherWithRuntimeState(this.providerOpts.tools, runtimeStateSource)
      : this.buildDispatcher(permissionMode, {
          ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
          ...(this._sharedReadRoots !== undefined ? { readRoots: this._sharedReadRoots } : {}),
          ...(this._sharedWriteRoots !== undefined ? { writeRoots: this._sharedWriteRoots } : {}),
          ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
          ...(config.parentSessionId !== undefined ? { parentSessionId: config.parentSessionId } : {}),
          ...(config.traceWriter !== undefined ? { traceWriter: config.traceWriter } : {}),
          runtimeStateSource,
          ...(config.isSkillDispatch ? { isSkillDispatch: true } : {}),
          ...(config.isNonInteractive ? { isNonInteractive: true } : {}),
          ...(config.hookRegistry !== undefined ? { hookRegistry: config.hookRegistry } : {}),
          ...(config.planExitControls !== undefined ? { planExitControls: config.planExitControls } : {}),
        });

    const buildOpts: {
      baseURL?: string;
      toolDispatcher?: ToolDispatcher;
      onPermissionMode?: (mode: string) => void;
      mcpManager?: import('../../mcp/index.js').McpManager;
    } = {};
    // Per-slot / per-session baseURL (`config.openaiBaseUrl`, set by
    // applySlotCredentials) wins over the construction-time global
    // (`providerOpts.baseURL`, from AFK_OPENAI_BASE_URL) so a tier bound to its
    // own endpoint overrides the process default. See model-slots Stage 2.
    const effectiveBaseURL = config.openaiBaseUrl ?? this.providerOpts.baseURL;
    if (effectiveBaseURL !== undefined) buildOpts.baseURL = effectiveBaseURL;
    buildOpts.toolDispatcher = dispatcher;
    // Path-approval half of the live `/bypass` toggle: keep the provider's
    // `_currentPermissionMode` (read by getGrants().allowAll) in sync with the
    // query handle's mode. File-tool half is the dispatcher's setAllowAll().
    buildOpts.onPermissionMode = (mode: string) => {
      this._currentPermissionMode = mode;
    };
    if (this.providerOpts.mcpManager !== undefined) buildOpts.mcpManager = this.providerOpts.mcpManager;

    // Phase 2 — Presence file lifecycle (top-level sessions only).
    const isTopLevel =
      (config.depth === undefined || config.depth === 0) &&
      config.parentSessionId === undefined;
    if (isTopLevel && config.sessionId !== undefined && this._presenceSessionId === null) {
      this._presenceSessionId = config.sessionId;
      const sessionId = config.sessionId;
      const workspace = runtimeStateSource.getWorkspace();
      void writePresenceFile({
        sessionId,
        surface: this.providerOpts.surface ?? 'cli',
        // Top-level gate above ⇒ depth 0/undefined ⇒ 'main'. Derived (not
        // hardcoded) to stay correct if that gate is ever changed.
        actor: actorFromDepth(config.depth),
        cwd: config.cwd ?? process.cwd(),
        startedAt: new Date().toISOString(),
        model: { provider: PROVIDER_NAME, name: modelName },
        workspace,
        pid: process.pid,
      });
      process.once('exit', () => { removePresenceFileSync(sessionId); });
      process.once('SIGINT', () => { removePresenceFileSync(sessionId); process.exit(130); });
      process.once('SIGTERM', () => { removePresenceFileSync(sessionId); process.exit(143); });
    }

    // Phase 2 — add `# Environment` block to the system prompt.
    const envFragment = formatEnvironmentFragment({
      cwd: config.cwd ?? process.cwd(),
      ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
      surface: this.providerOpts.surface ?? 'cli',
      ...(config.depth !== undefined ? { depth: config.depth } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
      workspace: runtimeStateSource.getWorkspace(),
    });
    const existingSys =
      typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined;
    const patchedConfig: typeof config = {
      ...config,
      systemPrompt: existingSys !== undefined
        ? `${existingSys}\n\n${envFragment}`
        : envFragment,
    };

    return buildQueryFromConfig(patchedConfig, args.prompt, buildOpts);
  }

  /**
   * Per-query dispatcher build. Closes over the session's permissionMode +
   * cwd so concurrent sessions in different worktrees don't race on
   * `process.cwd()`. Same pattern as `AnthropicDirectProvider.buildDispatcher`.
   */
  private buildDispatcher(
    permissionMode: string,
    opts: {
      cwd?: string;
      readRoots?: string[];
      writeRoots?: string[];
      sessionId?: string;
      parentSessionId?: string;
      traceWriter?: import('../../trace/index.js').TraceWriter;
      /**
       * Live source for the `get_runtime_state` tool — see the matching
       * comment in `anthropic-direct/index.ts:buildDispatcher`.
       */
      runtimeStateSource?: RuntimeStateSource;
      /**
       * When true, this is a skill-dispatch sub-agent: strip the `ask_question`
       * escape-hatch tool so it cannot ask the operator "which skill?". Parity
       * with the `config.isSkillDispatch` toolDefs filter in
       * AnthropicDirectProvider.
       */
      isSkillDispatch?: boolean;
      /**
       * When true, this is a non-interactive surface (daemon, scheduler/cron,
       * one-shot chat) where no human answers elicitations. Strip `ask_question`
       * only (not `terminal_font_size`). Parity with the `config.isNonInteractive`
       * toolDefs filter in AnthropicDirectProvider.
       */
      isNonInteractive?: boolean;
      /**
       * Session-scoped hook registry from `AgentConfig.hookRegistry`. Threaded
       * here so `PreToolUse`/`PostToolUse` hooks (notably the plan-mode gate)
       * fire on the per-query dispatcher. Falls back to the constructor-time
       * `providerOpts.hookRegistry` when unset. Mirrors AnthropicDirectProvider.
       */
      hookRegistry?: import('../../hooks.js').HookRegistry;
      /**
       * Session-control bridge for `exit_plan_mode`, forwarded from the query
       * config (top-level sessions only). When set AND `permissionMode ===
       * 'plan'`, the handler + schema are registered. Mirrors AnthropicDirectProvider.
       */
      planExitControls?: PlanExitControls;
    },
  ): SessionToolDispatcher {
    const handlers = createBuiltinHandlers(permissionMode, opts.cwd);
    const memoryHandlers = createMemoryHandlers(
      this.memoryStore,
      undefined,
      this.providerOpts.surface ?? 'cli',
    );
    for (const [name, handler] of memoryHandlers) {
      if (this.providerOpts.readOnlyMemory === true && name !== 'memory_search') continue;
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
    for (const t of this.providerOpts.customTools ?? []) {
      if (!handlers.has(t.schema.name)) {
        handlers.set(t.schema.name, t.handler);
      }
    }
    // Plan-exit tool: registered per-query ONLY while in plan mode and only when
    // the session supplied control callbacks (top-level sessions). Mirrors
    // AnthropicDirectProvider.buildDispatcher; schema appended below to match.
    const planExitControls = permissionMode === 'plan' ? opts.planExitControls : undefined;
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

    // Invariant: skill-dispatch sub-agents must never pause to ask the operator
    // "which skill?" nor mutate the operator's environment. Strip `ask_question`
    // (operator-prompt escape hatch) and `terminal_font_size` (an environment tool
    // a bare numeric skill arg can lure a confused model into). Parity with the
    // toolDefs filter in AnthropicDirectProvider. No skill calls either tool.
    const baseSchemas = opts.isSkillDispatch
      ? this.schemas.filter(
          (t) => t.name !== 'ask_question' && t.name !== 'terminal_font_size',
        )
      : opts.isNonInteractive
        ? this.schemas.filter((t) => t.name !== 'ask_question')
        : this.schemas;

    const dispatcherOpts: ConstructorParameters<typeof SessionToolDispatcher>[0] = {
      handlers,
      // Constraint (semantic invariant): MCP schemas appended AFTER builtins
      // so builtin tool names always take precedence in any overlap. Plan-exit
      // schema appended last, only while the tool is active (plan mode).
      schemas: [...baseSchemas, ...mcpSchemas, ...(planExitControls ? [exitPlanModeTool] : [])],
      // Session hook registry via the one canonical resolver (query-scoped
      // config registry wins over any constructor-provided one). Mirrors
      // AnthropicDirectProvider; the required key on the dispatcher options
      // makes a silent drop (c6892c6) a compile error.
      hookRegistry: resolveSessionHookRegistry(opts.hookRegistry, this.providerOpts.hookRegistry),
    };
    // Union live MCP wire-names AND consumer-registered custom-tool names into
    // the (statically-snapshotted) allowlist so neither is rejected by the gate
    // while present in `schemas`/`handlers`. No-op when there is no allowlist
    // (undefined => all allowed) or nothing to union. Mirrors
    // AnthropicDirectProvider; restricted sub-agents carry no customTools.
    const effectivePermissions = withCustomToolsAllowed(
      this.providerOpts.mcpManager
        ? withMcpToolsAllowed(
            this.providerOpts.permissions,
            this.providerOpts.mcpManager.getMcpToolWireNames(),
          )
        : this.providerOpts.permissions,
      (this.providerOpts.customTools ?? []).map((t) => t.schema.name),
    );
    if (effectivePermissions !== undefined)
      dispatcherOpts.permissions = effectivePermissions;
    if (this.providerOpts.subagentExecutor !== undefined)
      dispatcherOpts.subagentExecutor = this.providerOpts.subagentExecutor;
    if (this.providerOpts.skillExecutor !== undefined)
      dispatcherOpts.skillExecutor = this.providerOpts.skillExecutor;
    if (this.providerOpts.composeExecutor !== undefined)
      dispatcherOpts.composeExecutor = this.providerOpts.composeExecutor;
    if (opts.cwd !== undefined) dispatcherOpts.cwd = opts.cwd;
    if (opts.readRoots !== undefined) dispatcherOpts.readRoots = opts.readRoots;
    if (opts.writeRoots !== undefined) dispatcherOpts.writeRoots = opts.writeRoots;
    if (opts.sessionId !== undefined) dispatcherOpts.sessionId = opts.sessionId;
    if (opts.parentSessionId !== undefined) dispatcherOpts.parentSessionId = opts.parentSessionId;
    if (opts.traceWriter !== undefined) dispatcherOpts.traceWriter = opts.traceWriter;
    // Read-only-skill bash gate — parity with anthropic-direct. Forwarded from
    // the provider's construction-time flag so a read-only skill's forked
    // OpenAI-routed child also blocks mutating shell commands.
    if (this.providerOpts.readOnlyBash === true) dispatcherOpts.readOnlyBash = true;
    // Path-containment bypass: bypassPermissions (explicit) + autonomous (AFK)
    // both disable path containment for every per-call context.
    dispatcherOpts.allowAll = pathContainmentBypassed(permissionMode);

    return new SessionToolDispatcher(dispatcherOpts);
  }

  private ensureSharedRoots(cwd?: string): void {
    if (!this._sharedReadRoots) {
      const defaultRoots = cwd ? [cwd] : [];
      this._sharedReadRoots = defaultRoots.slice();
      this._sharedWriteRoots = defaultRoots.slice();
      if (cwd && !this._initialResolveBase) this._initialResolveBase = cwd;
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

  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.ensureSharedRoots();
    const p = path.resolve(absPath);
    if (!this._sharedReadRoots!.includes(p)) this._sharedReadRoots!.push(p);
    this.appendProviderAuditLog({ action: 'grant-read', path: p, source, sessionId });
  }

  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.ensureSharedRoots();
    const p = path.resolve(absPath);
    if (!this._sharedReadRoots!.includes(p)) this._sharedReadRoots!.push(p);
    if (!this._sharedWriteRoots!.includes(p)) this._sharedWriteRoots!.push(p);
    this.appendProviderAuditLog({ action: 'grant-write', path: p, source, sessionId });
  }

  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    if (!this._sharedReadRoots) return;
    const p = path.resolve(absPath);
    if (this._initialResolveBase && p === this._initialResolveBase) return;
    const rIdx = this._sharedReadRoots.indexOf(p);
    if (rIdx !== -1) this._sharedReadRoots.splice(rIdx, 1);
    if (this._sharedWriteRoots) {
      const wIdx = this._sharedWriteRoots.indexOf(p);
      if (wIdx !== -1) this._sharedWriteRoots.splice(wIdx, 1);
    }
    this.appendProviderAuditLog({ action: 'revoke', path: p, source, sessionId });
  }

  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[]; allowAll: boolean } {
    return {
      resolveBase: this._initialResolveBase,
      readRoots: this._sharedReadRoots?.slice() ?? [],
      writeRoots: this._sharedWriteRoots?.slice() ?? [],
      allowAll: pathContainmentBypassed(this._currentPermissionMode),
    };
  }

  /**
   * Best-effort append to `session-grants.jsonl`. Mirrors
   * `AnthropicDirectProvider.appendProviderAuditLog` (index.ts:269-289 of
   * anthropic-direct). Inlined rather than extracted to keep the providers
   * independently revertable; consolidate when a third provider needs the
   * same logic.
   */
  private appendProviderAuditLog(entry: {
    action: 'grant-read' | 'grant-write' | 'revoke';
    path: string;
    source: 'slash' | 'tool';
    sessionId?: string;
  }): void {
    try {
      const logPath = getSessionGrantsPath();
      mkdirSync(dirname(logPath), { recursive: true });
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? null,
        action: entry.action,
        path: entry.path,
        source: entry.source,
      });
      appendFileSync(logPath, line + '\n');
    } catch {
      // Audit log is best-effort.
    }
  }

  close(): void {
    this.memoryStore.close();
  }

  /**
   * Single-shot completion (see {@link ModelProvider.complete}). Resolves auth
   * via {@link resolveOpenAIAuth} (the standard `OPENAI_API_KEY` →
   * `CODEX_API_KEY` → `~/.codex/auth.json` chain) and honours the
   * provider's construction-time `baseURL` so local MLX / llama.cpp / vLLM
   * shims are reached transparently.
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
    if (args.signal) input.signal = args.signal;
    return oneShotChatCompletion(input);
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
