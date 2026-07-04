/**
 * Agent session configuration types.
 * @module agent/types/config-types
 */

import type {
  AgentDefinition,
  EffortLevel,
  HookCallbackMatcher,
  HookEvent,
  OnElicitation,
  PermissionMode,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
} from './sdk-types.js';
import type { HookRegistry } from '../hooks.js';
import type { ModelProvider } from '../provider.js';
import type { TraceWriter } from '../trace/index.js';
import type { AgentModelInput } from './model-types.js';
import type { ModelSlots } from '../session/model-slots.js';
import type { CanUseTool, PermissionBubbler } from './permission-types.js';
import type { Surface } from '../awareness/types.js';

/** Tool permissions configuration */
export interface ToolConfig {
  /** List of allowed tool names. Empty array means no tools allowed. */
  allowedTools?: string[];
  /** List of tool names that are disallowed. */
  disallowedTools?: string[];
}

/** Text-only turns restored from an AFK session sidecar. */
export interface ResumeHistoryTurn {
  user: string;
  assistant: string;
}

/**
 * Session-control callbacks handed to the model-callable `exit_plan_mode` tool
 * so an approved plan exit can queue the crafted implement-turn for the REPL to
 * auto-submit after the current turn — reproducing `/plan off`'s
 * save-and-implement handoff from a model-proposed, elicitation-confirmed exit.
 *
 * **Deferred-flip contract**: the handler does NOT flip the permission mode
 * mid-turn. Instead it records the approved mode alongside the seed message via
 * `requestImplementSeed`. The mode flip is deferred to the post-turn drain
 * boundary in `src/cli/commands/interactive/loop-iteration.ts`, where
 * `takePendingPlanExitSeed()` atomically applies the flip and promotes the seed
 * — so the gate stays locked in plan mode for the entire current turn and only
 * opens for the clean, seeded implement-turn that follows.
 *
 * Populated by `AgentSession` for top-level sessions only (plan mode is a REPL
 * affordance); the `exit_plan_mode` schema is offered solely while
 * `permissionMode === 'plan'`, so these callbacks are inert on every other
 * surface. See `src/agent/tools/handlers/exit-plan-mode.ts` and the seed drain
 * at `src/cli/commands/interactive/loop-iteration.ts`.
 */
export interface PlanExitControls {
  /** Flip the live session permission mode on approval (e.g. 'default' | 'bypassPermissions'). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Queue the crafted implement-turn message AND the approved mode for the REPL
   * to apply atomically at the post-turn drain boundary. The mode flip is NOT
   * applied here — it is deferred to `takePendingPlanExitSeed()`.
   */
  requestImplementSeed(message: string, mode: PermissionMode): void;
  /**
   * The permission mode the session was in immediately BEFORE it entered plan
   * mode — captured by `AgentSession.setPermissionMode` on the flip into 'plan'.
   * An approved exit restores THIS mode instead of forcing 'default', so a user
   * who was (say) in bypass before planning lands back in bypass. Returns
   * `undefined` when nothing was captured (the session started in plan, or the
   * prior mode was 'autonomous' — AFK has dedicated enter/exit machinery and is
   * not restorable by a bare flip); callers fall back to 'default'.
   */
  getPrePlanMode(): PermissionMode | undefined;
}

/** Agent session configuration */
export interface AgentConfig {
  /**
   * Model to use. Accepts short aliases (`opus`, `opus_1m`, `sonnet`,
   * `sonnet_1m`, `haiku`) that get expanded to full Claude model IDs, OR
   * any raw string that downstream providers understand (e.g. `auto` when
   * routing through `cursor-api-proxy`, or a full `claude-*` ID).
   * Unknown strings pass through to the SDK untouched — see `resolveModelId`.
   */
  model: AgentModelInput;

  /**
   * User-configurable model-slot bindings (Stage 1). Rebinds the four
   * capability tiers (`local`/`small`/`medium`/`large`) to concrete model ids.
   * When present, installed process-globally so every routing call site resolves
   * tier aliases correctly. Normally populated by `loadConfig()` from the
   * `models` block in afk.config.json + `AFK_MODEL_{LOCAL,SMALL,MEDIUM,LARGE}` env;
   * passing it directly here is supported for library/test use. Stage 2 will
   * add per-slot provider/baseUrl/apiKey. See `agent/session/model-slots.ts`.
   */
  models?: ModelSlots;

  /** Anthropic API key. Optional when using system claude binary with OAuth. */
  apiKey?: string;

  /** Base URL for Anthropic API (optional) */
  baseUrl?: string;

  /**
   * Base URL for an OpenAI-compatible Chat Completions endpoint (optional).
   * Forwarded as the SDK's `baseURL` option when the openai-compatible
   * provider builds its client — overrides any construction-time default.
   *
   * Symmetric counterpart of `baseUrl` (Anthropic): used to point at
   * self-hosted OpenAI-compatible servers like `mlx_lm.server`, Ollama's
   * OpenAI-compat endpoint, vLLM, LM Studio, llama.cpp's server, etc.
   *
   * When set via `AFK_OPENAI_BASE_URL`, the env loader also injects a
   * placeholder `apiKey` (sourced from `AFK_OPENAI_API_KEY`, default
   * `'local'`) so the OpenAI SDK can construct a client against servers
   * that do not validate keys.
   */
  openaiBaseUrl?: string;

  /** Maximum number of conversation turns (optional) */
  maxTurns?: number;

  /**
   * Controls Claude's extended-thinking / reasoning behavior. When omitted,
   * the SDK picks the model-appropriate default (adaptive on Opus 4.6+).
   * See the SDK's `ThinkingConfig` union.
   */
  thinking?: ThinkingConfig;

  /**
   * Effort level guiding adaptive thinking depth. `'xhigh'` is Opus 4.7 only;
   * `'max'` is Opus 4.6/4.7 only — the SDK/API rejects unsupported pairs.
   */
  effort?: EffortLevel;

  /** Tool configuration (optional) */
  tools?: ToolConfig;

  /** Claude SDK permission mode */
  permissionMode?: PermissionMode;

  /** Hook callbacks for SDK events (V2). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  /** Custom permission handler for tool usage (V2). */
  canUseTool?: CanUseTool;

  /**
   * Bubbles tool permission requests to a parent handler.
   * Used by SubagentManager to forward canUseTool from child sessions to the
   * parent. Takes lower precedence than an explicit `canUseTool`.
   */
  permissionBubbler?: PermissionBubbler;

  /** Which settings to load (user, project, local). Passed through when SDK V2 supports it. */
  settingSources?: SettingSource[];

  /**
   * Extra plugins to load on top of whatever AFK auto-discovers under
   * `~/.afk/plugins/`. Each entry is passed to the SDK's `plugins:` option as
   * `{ type: 'local', path }`. Useful for dev paths outside the plugins dir or
   * for programmatic overrides.
   */
  plugins?: SdkPluginConfig[];

  /** System prompt: string or preset with optional append. Passed through when SDK V2 supports it. */
  systemPrompt?:
    | string
    | { type: 'preset'; preset: 'claude_code'; append?: string };

  /**
   * Provenance string describing where `systemPrompt` came from — e.g.
   * `"env:AFK_SYSTEM_PROMPT"`, `"file:/abs/path/afk.config.json"`,
   * `"afk-md:/abs/path/AFK.md"`, `"none"`.
   *
   * Provenance-only: consumed by the prompt-dump debug feature
   * (`src/agent/session/prompt-dump.ts`). Must NOT be forwarded to the
   * SDK options object in `buildQueryOptions`.
   */
  systemPromptSource?: string;

  /**
   * MCP server config — typed entry-point for `~/.afk/config/mcp.json`.
   *
   * Populated by `loadMcpConfig()` and consumed by the bootstrap path
   * which constructs an `McpManager` and threads it into the provider.
   * Forwarded provider-side; not part of the Anthropic Messages API
   * request payload.
   */
  mcpServers?: Record<string, import('../mcp/types.js').McpServerConfig>;

  /**
   * Live MCP manager for the session. Entry points that own MCP lifecycle
   * construct this with `McpManager.fromConfig()` and close it after the
   * AgentSession shuts down; provider/session wiring only consumes it.
   */
  mcpManager?: import('../mcp/index.js').McpManager;

  /**
   * Programmatic named-agent definitions, merged into the session's
   * named-agent registry at the HIGHEST precedence (above project/user file
   * scopes — the analog of Claude Code's `--agents` CLI tier).
   *
   * NOT wired into any built-in surface today: the one-shot chat, daemon,
   * REPL, and Telegram bootstraps all call `loadAgentRegistry({ cwd })`
   * WITHOUT `configAgents`, and no config-file field populates this — so it
   * is a no-op unless a programmatic embedder builds the registry itself via
   * `loadAgentRegistry({ configAgents })`. File-scope agents (`.afk/agents/`,
   * `.claude/agents/`, `~/.afk/agents/`) are the supported path today.
   *
   * The registry powers the `agent` tool's `agent_type` dispatch (see
   * `src/agent/agents/`). Keys are agent names; values follow the
   * {@link AgentDefinition} shape (`prompt` = system prompt, `tools`/
   * `disallowedTools` in Claude Code or AFK tool vocabulary, `model`,
   * `maxTurns`; long-tail fields are tolerated but not honored yet).
   */
  agents?: Record<string, AgentDefinition>;

  /**
   * Main agent name when using `agents`. NOT currently consumed (reserved for
   * future SDK V2 support); has no effect today.
   */
  agent?: string;

  /**
   * Working directory for the session.
   *
   * Used as the `cwd` option for shell-spawning tool handlers (bash, grep)
   * and as the default base path for glob/grep when the model omits an
   * explicit `path` argument. Also forwarded to child subagent configs so
   * forked sessions inherit the parent's working tree.
   *
   * The Node process's `process.cwd()` is NEVER mutated — multiple sessions
   * with distinct `cwd` values can run concurrently in the same process.
   * Falls back to `process.cwd()` when unset.
   */
  cwd?: string;

  /**
   * Allowed roots for read-class tools (read_file, glob, grep,
   * list_directory). When omitted the dispatcher defaults to `[cwd]`.
   */
  readRoots?: string[];

  /**
   * Allowed roots for write-class tools (write_file, edit_file). When
   * omitted the dispatcher defaults to `[cwd]`.
   */
  writeRoots?: string[];

  /**
   * Extra environment variables to inject into Bash-tool subprocess spawns
   * for THIS session. Merged into the child's env on top of `process.env`,
   * with these entries winning on collision.
   *
   * Forwarded to the dispatcher and surfaced via `ToolHandlerContext.env`
   * on every handler invocation. Per-session (not process-global) so
   * concurrent forked subagents — e.g. plugin-skill dispatches — don't
   * clobber each other's `PLUGIN_ROOT`.
   *
   * Currently consumed only by the Bash handler; other handlers are free
   * to read this same key when env-aware behavior is added.
   */
  env?: Record<string, string>;

  /**
   * Enable file checkpointing for rewind. NOT currently consumed by any
   * provider (reserved for future SDK V2 support); has no effect today.
   */
  enableFileCheckpointing?: boolean;

  /**
   * Path to a Claude Code executable. NOT currently consumed — AFK runs its own
   * provider harness and never spawns a Claude Code CLI. Reserved for future
   * SDK V2 support; has no effect today.
   */
  pathToClaudeCodeExecutable?: string;

  /** Continue the most recent persisted session in the current working directory */
  continue?: boolean;

  /** Resume a specific persisted session ID */
  resume?: string;

  /**
   * Text transcript to seed providers that do not have native session
   * persistence. Native providers can ignore this and use {@link resume}.
   */
  resumeHistory?: ResumeHistoryTurn[];

  /** Override or seed the SDK session ID */
  sessionId?: string;

  /** Resume a persisted session at a specific assistant message UUID */
  resumeSessionAt?: string;

  /** Fork a resumed session into a new session ID */
  forkSession?: boolean;

  /** Persist the Claude session to disk. Defaults to true. */
  persistSession?: boolean;

  /**
   * External abort signal. When it fires the session aborts its internal
   * controller, interrupts the SDK, and subsequent {@link IAgentSession.sendMessage}
   * calls throw {@link AbortError}.
   */
  abortSignal?: AbortSignal;

  /**
   * Per-turn timeout in ms for {@link IAgentSession.sendMessage}. On expiry the
   * session's internal controller aborts (cascading to subagents) and the call
   * throws {@link TimeoutError}. Defaults to `0` (no timeout) — set explicitly
   * to enforce a per-turn deadline.
   */
  timeoutMs?: number;

  /**
   * Harness-owned hook registry. When provided, `AgentSession` dispatches
   * `SessionStart` before the SDK query is consumed and `SessionEnd` when
   * the session closes. `SubagentManager` uses the same registry (or a
   * child-specific one) to dispatch `SubagentStart` / `SubagentStop`.
   *
   * Distinct from {@link AgentConfig.hooks}, which configures native SDK
   * hook callbacks. The two can coexist — this is harness policy; that is
   * SDK event plumbing.
   */
  hookRegistry?: HookRegistry;

  /**
   * Session-control bridge for the model-callable `exit_plan_mode` tool. When
   * present (top-level sessions), the providers register the `exit_plan_mode`
   * handler + schema while `permissionMode === 'plan'`. Absent → the tool is
   * never offered. See {@link PlanExitControls}.
   */
  planExitControls?: PlanExitControls;

  /**
   * Witness-layer trace writer. When provided, {@link IAgentSession}
   * emits structured trace events for tool calls, hook decisions,
   * subagent lifecycle transitions, budget breaches, aborts,
   * compaction, closure, and the terminal seal. Subagent forks
   * **share** the parent's writer — child events appear in the same
   * trace file with a `subagentId` annotation in their payload.
   *
   * See `docs/philosophy/afk-contract.md` for the contract this
   * writer makes enforceable, and `src/agent/trace/` for shapes.
   */
  traceWriter?: TraceWriter;

  /**
   * Model provider. Defaults to the Anthropic SDK adapter
   * (`anthropicProvider`) when omitted. Supplying a custom provider lets
   * the harness drive non-Anthropic backends without touching session
   * logic. See `src/agent/provider.ts`.
   */
  provider?: ModelProvider;

  /**
   * Fully-wired provider factory for mid-session cross-family model switching.
   *
   * When set (and `provider` is unset), `AgentSession` installs a `ProviderRouter`
   * that calls this factory to resolve the active provider for the current model
   * — once at session initialization and again on each cross-family `/model`
   * switch (the router reuses the active inner across turns of the same family,
   * so the factory is NOT called every turn). The factory receives the model
   * string and must return a fully-wired `ModelProvider` — one with
   * `subagentExecutor`, `skillExecutor`, `composeExecutor`, `memoryStore`,
   * `mcpManager`, and permission lists already configured. This is the mechanism
   * that allows the REPL's `/model` command to switch across provider families
   * (e.g. Claude → GPT) without dropping the `agent`/`skill`/`compose` tools or
   * MCP bridges.
   *
   * Implementations that hold per-instance state (e.g. `/allow-dir` grant roots)
   * should memoize by family so repeated calls for the same family return the
   * same instance — see `createMemoizedProviderFactory` in the REPL bootstrap.
   *
   * Ignored when `provider` is explicitly set (injected-provider path, used by
   * Telegram and the daemon, takes precedence). When both are unset, `AgentSession`
   * falls back to the bare `resolveProvider` function which builds providers
   * without executor/MCP wiring — suitable for one-shot and non-interactive paths.
   *
   * @param model - The resolved model string for the upcoming turn, or
   *   `undefined` when no model has been selected yet. Matches the value that
   *   would be passed to `providerForModel()`.
   */
  providerFactory?: (model: string | undefined) => ModelProvider;

  // --- SDK adoption wave (Wave 0 shared surface) ---
  // Each field is a thin passthrough into the provider's underlying
  // request options. Guarded by buildQueryOptions so omitting them
  // preserves pre-adoption behavior.

  /**
   * Hard cost ceiling for the whole session, in USD. When the SDK detects
   * cumulative spend has crossed this threshold it aborts cleanly. Useful
   * as a safety net for the daemon + bypass-permissions posture.
   */
  maxBudgetUsd?: number;

  /**
   * Soft per-task token budget. When set, the SDK surfaces the remaining
   * token budget to the model so it can pace tool use. Unlike
   * {@link maxBudgetUsd} this does not forcibly abort — it just informs
   * task planning. Stored as a plain number for CLI ergonomics;
   * `buildQueryOptions` wraps it into the SDK's `{ total }` shape.
   *
   * @see https://docs.anthropic.com — `task-budgets-2026-03-13` beta header
   */
  taskBudget?: number;

  /**
   * Hard per-response output-token cap (the Messages-API `max_tokens`).
   * Resolved by `resolveMaxTokens` in the anthropic-direct provider and
   * clamped to the model's output ceiling (`maxOutputTokensFor`): an
   * over-ceiling value is reduced to the ceiling rather than sent verbatim
   * (which the API would reject with HTTP 400). Any non-finite or non-positive
   * value — including the `Number.POSITIVE_INFINITY` "model max" sentinel that
   * `parseMaxOutputTokens` emits for `--max-output-tokens max` — falls back to
   * the model ceiling.
   */
  maxOutputTokens?: number;

  /**
   * When true, the SDK streams partial assistant message chunks in addition
   * to final messages. Useful for richer TUI / bridge rendering.
   */
  includePartialMessages?: boolean;

  /**
   * When true, the SDK surfaces hook lifecycle events in the message stream
   * (PreToolUse / PostToolUse / Elicitation / etc). Complementary to the
   * harness's own {@link hookRegistry}; this is SDK-side visibility.
   */
  includeHookEvents?: boolean;

  /**
   * When true, the SDK emits human-readable progress summaries for long
   * subagent runs. Maps naturally to progress banners in the REPL and
   * incremental edits in Telegram/iMessage bridges.
   */
  agentProgressSummaries?: boolean;

  /**
   * Callback invoked when an MCP server requests elicitation (OAuth URL,
   * form field, consent prompt, etc.). When omitted the SDK auto-declines,
   * preserving current behavior. Agent-afk installs an elicitation router
   * in `src/agent/elicitation-router.ts` that the CLI wires to a REPL
   * prompt; bridges can install their own handler.
   */
  onElicitation?: OnElicitation;

  /**
   * When true (the default), the provider automatically waits for the
   * OAuth subscription reset and replays the in-flight turn instead of
   * surfacing a raw 429 error. Set to false to disable auto-resume and
   * surface the error immediately after showing the usage-limit card.
   */
  autoResumeOnUsageLimit?: boolean;

  // --- Awareness metadata (Phase 1: get_runtime_state) ---
  // Pure metadata fields surfaced through the `get_runtime_state` tool's
  // `self` view. All optional — top-level sessions leave them undefined and
  // the snapshot reports `null` for the missing values. Populated by
  // `SubagentManager.forkSubagent` + `SubagentExecutor` for forked children
  // so subagents can introspect their place in the topology.

  /**
   * User-facing execution surface that produced this session (the same value
   * the provider stores at `opts.surface`). Set by each top-level entrypoint
   * (REPL → 'cli', `afk chat` → 'cli', daemon/scheduler → 'daemon', Telegram →
   * 'telegram'); forked subagents inherit the parent's value. Persisted to the
   * witness trace as `origin` on `session_init_start` so trace-only analysis can
   * distinguish cli/telegram/daemon. Distinct from the JSONL telemetry
   * `surface: 'afk'|'plugin'` provenance tag. Optional/back-compat — undefined
   * maps to `origin: 'unknown'`.
   */
  surface?: Surface;

  /** Parent session ID when this session was forked as a subagent. */
  parentSessionId?: string;

  /** Nesting depth assigned at fork (0-indexed). Top-level → undefined. */
  depth?: number;

  /** Maximum allowed nesting depth at fork time. */
  maxDepth?: number;

  /** Phase enforcement tag inherited from `ForkSubagentOptions.phaseRole`. */
  phaseRole?: 'read-only' | 'read-write';

  /**
   * When true, the session is a skill-dispatch sub-agent (forked by
   * `SkillExecutor` or the user-skill handler in `skills/user-skills.ts`).
   * Providers use this flag to omit the `SLASH_COMMAND_ROUTING_PROMPT`
   * paragraph and to strip the `ask_question` escape-hatch tool from the
   * assembled toolset. Skill sub-agents receive a "Run the <name> skill"
   * directive (no `<command-name>` tag); without these adjustments the routing
   * instruction and the ask_question tool push them to ask the operator "which
   * skill?" instead of engaging with the SKILL.md body in their system prompt.
   *
   * Default: `false` (main sessions keep the routing instruction and tool).
   */
  isSkillDispatch?: boolean;

  /**
   * When true, the session runs on a non-interactive surface where no human is
   * available to answer an `ask_question` elicitation — the daemon, a
   * scheduler/cron-launched task, or a one-shot `afk chat` invocation. On these
   * surfaces no elicitation handler is installed (see `elicitation-router.ts`),
   * so an `ask_question` call can only auto-decline; offering the tool merely
   * lets the model burn a turn calling something that structurally cannot
   * succeed. Providers therefore strip `ask_question` from the assembled
   * toolset, forcing the model to proceed on a stated assumption or emit a
   * Blocked terminal state instead.
   *
   * Parallels the structural `ask_question` strip already applied for
   * skill-dispatch sub-agents (`isSkillDispatch`), but is intentionally
   * narrower: ONLY `ask_question` is removed — `terminal_font_size` is retained
   * (its skill-dispatch-specific numeric-arg lure does not apply here).
   *
   * Interactive surfaces (REPL, Telegram) leave this unset so a human can still
   * be asked even when away-from-keyboard. Forked sub-agents default this to
   * `true` (see `subagent.ts`): a sub-agent has no human relationship of its own
   * and must return Blocked/Asking findings to its parent rather than eliciting
   * the operator directly. Callers may override a fork with
   * `isNonInteractive: false`.
   *
   * Default: `false`.
   */
  isNonInteractive?: boolean;

  /**
   * Opt-in automatic compaction. When the context window fills past the
   * configured threshold, `compact()` fires automatically at the next idle
   * turn boundary (no tool call in flight, not already compacting).
   *
   * - `false` (default) — disabled; compact only via `/compact` or
   *   `session.compact()` programmatically.
   * - `true` — enabled with the default threshold of 0.90 (90%).
   * - `{ threshold: 0.85 }` — enabled with a custom fraction (0–1 exclusive).
   *
   * The threshold is evaluated against
   * `(inputTokens + outputTokens + cachedInputTokens + cacheCreationTokens) / contextLimit`
   * from the last completed turn. Auto-compaction is guarded by
   * `abort.isIdle()` so it never fires while a turn is in flight, and
   * by the existing re-entrance lock in `compact-handler.ts`.
   */
  autoCompact?: boolean | { threshold: number };

  /**
   * In-process custom tools available to the session. Each entry is created
   * via the `tool()` helper and provides both a JSON-schema `AnthropicToolDef`
   * (so the model knows the tool exists) and a validated `ToolHandler`
   * (so the dispatcher can execute it).
   *
   * Forwarded to the provider ONLY on the bare `resolveProvider` fallback path
   * (neither `provider` nor `providerFactory` set) — the common library
   * `query()` case. When `provider` (injected) or `providerFactory` is supplied,
   * that provider owns its own tool wiring and these `customTools` are NOT
   * auto-forwarded; register them on the injected/constructed provider yourself.
   * See `resolveProvider` (`src/agent/providers/index.ts`) and `agent-session.ts`.
   *
   * Permission gate and PreToolUse/PostToolUse hooks apply identically to
   * custom tools and built-in tools (no bypass). When an `allowedTools`
   * allowlist is configured, custom-tool names are unioned into it
   * automatically (see `withCustomToolsAllowed`), so registering a custom tool
   * is the grant — it is not denied by the gate.
   */
  customTools?: import('../tools/custom-tool.js').CustomToolDef[];
}
