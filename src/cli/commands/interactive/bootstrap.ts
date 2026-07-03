import * as readline from 'node:readline';
import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import { AgentSession } from '../../../agent/session.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';
import { unconfiguredSlotError } from '../../../agent/session/model-slots.js';
import { createDefaultHookRegistry } from '../../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory } from '../../../agent/memory/index.js';
import type { ThinkingConfig, EffortLevel } from '../../../agent/types.js';
import type { AgentConfig } from '../../../agent/types.js';
import type { ModelProvider } from '../../../agent/provider.js';
import type { HookRegistry } from '../../../agent/hooks.js';
import type { TraceWriter } from '../../../agent/trace/index.js';
import {
  parseThinking, parseEffort, parseMaxOutputTokens, parseProvider, getApiKey, getApiKeyForModel, getModel, getThinking, getEffort,
  getMaxOutputTokens, getDefaultSubagentModel, resolveBaseSystemPrompt, isGrantManager,
} from '../../shared-helpers.js';
import { topLevelSurfaceAllowedTools } from '../../../agent/tools/top-level-allowlist.js';
import { loadConfig } from '../../config.js';
import { assembleSystemPrompt } from '../../../agent/routing-directive.js';
import { StatusLine } from '../../status-line.js';
import { GitStatusSampler } from '../../git-status-sampler.js';
import { registerAll } from '../../slash/index.js';
import { setAllowDirDispatcher } from '../../slash/commands/allow-dir.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { createSessionStats } from '../../slash/session-stats.js';
import type { SlashContext } from '../../slash/types.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { CliOptions, CompletionWriter, InteractiveCtx } from './shared.js';
import { formatStatusFields } from './shared.js';
import { createReplRenderer } from './repl-renderer.js';
import { TrustedSkillLedger } from '../../trusted-skill-ledger.js';
import {
  onTrustedSkillComplete, offTrustedSkillComplete,
  onTrustedSkillStart, offTrustedSkillStart,
} from '../../../agent/_lib/trusted-skill-events.js';
import { formatTrustedSkillCompletion, formatTrustedSkillInFlight } from '../../trusted-skill-badge.js';
import type { TrustedSkillResult } from '../../../agent/trusted-skill-result.js';
import { formatSubagentCompletion } from './progress-banner.js';
import { ContextSampler } from '../../context-sampler.js';
import { SubagentManager } from '../../../agent/subagent.js';
import { SubagentExecutor } from '../../../agent/tools/subagent-executor.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { BackgroundSummarizer } from '../../../agent/background-summarizer.js';
import { setBgsubRegistry, setBgsubSummarizer } from '../../slash/commands/bgsub.js';
import { SkillExecutor } from '../../../agent/tools/skill-executor.js';
import { ComposeExecutor } from '../../../agent/tools/compose-executor.js';
import { createChildProviderFactory, createChildSkillExecutorFactory } from '../../../agent/tools/nesting.js';
import { AnthropicDirectProvider } from '../../../agent/providers/anthropic-direct/index.js';
import { seedPersistedGrants } from '../../../agent/permissions-store.js';
import { providerForModel } from '../../../agent/providers/index.js';
import { createMemoizedProviderFactory } from './provider-factory.js';
import { ensurePluginEntrypointsLoaded } from '../../../agent/tools/skill-bridge.js';
import { McpManager, loadMcpConfig, getMcpConfigPath } from '../../../agent/mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../../config/import-sources.js';
import { env } from '../../../config/env.js';
import { resolveResumeTarget } from '../../resume-session.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';
import { emitSessionPhase } from '../../../agent/trace/emit.js';
import { palette } from '../../palette.js';
import { performResumeSwap, resumeConfigFor } from './resume-swap.js';
import { reseedStatsFromStored } from './shared.js';

/**
 * Dependencies for constructing a fresh `AgentSession`. Captures everything
 * the constructor block reads so `buildAgentSession` can be called both from
 * `bootstrapSession` (initial) and from the mid-session swap path.
 */
interface BuildAgentSessionDeps {
  model: string;
  resumeConfig: Partial<AgentConfig>;
  systemPrompt: string | undefined;
  systemPromptSource: string | undefined;
  thinking: ThinkingConfig | undefined;
  effort: EffortLevel | undefined;
  maxOutputTokens: number | undefined;
  /**
   * Fully-wired provider factory. Passed as `config.providerFactory` so the
   * ProviderRouter builds a wired provider (with executors, memoryStore,
   * mcpManager) on every turn — enabling cross-family /model swaps without
   * losing the agent/skill/compose tools or MCP bridges.
   */
  providerFactory: (model: string | undefined) => ModelProvider;
  hookRegistry: HookRegistry;
  traceWriter: TraceWriter | undefined;
  cwd: string | undefined;
  maxTurns: number;
  autoResumeOnUsageLimit: boolean | undefined;
  /** Initial session permission mode (e.g. 'bypassPermissions'). Omit for 'default'. */
  permissionMode?: PermissionMode;
  baseUrl?: string;
}

/**
 * Construct a fresh `AgentSession` from the supplied deps. Extracted so the
 * mid-session swap path can build a new session with a different `resumeConfig`
 * without duplicating the constructor argument list.
 */
export function buildAgentSession(deps: BuildAgentSessionDeps): AgentSession {
  return new AgentSession(injectHotMemory({
    model: deps.model,
    // User-facing surface for trace `origin` attribution. The REPL is a CLI
    // entrypoint → 'cli'. (Mid-session swap reuses this helper, also 'cli'.)
    surface: 'cli',
    // Resolve the credential for the ACTUAL session model, not the env-derived
    // default. `getApiKey()` keys off AFK_MODEL/CLAUDE_MODEL, so launching
    // `afk -m gpt-5.5` while CLAUDE_MODEL is a Claude id would inject the
    // Anthropic OAuth token into the OpenAI provider — leaking sk-ant-… to
    // OpenAI and shadowing Codex ChatGPT OAuth. getApiKeyForModel routes via
    // providerForModel → the correct family (anti-leak invariant).
    apiKey: getApiKeyForModel(deps.model),
    maxTurns: deps.maxTurns,
    hookRegistry: deps.hookRegistry,
    ...(deps.permissionMode !== undefined ? { permissionMode: deps.permissionMode } : {}),
    ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
    ...(deps.systemPromptSource !== undefined ? { systemPromptSource: deps.systemPromptSource } : {}),
    ...(deps.thinking !== undefined ? { thinking: deps.thinking } : {}),
    ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
    ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    ...deps.resumeConfig,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.traceWriter !== undefined ? { traceWriter: deps.traceWriter } : {}),
    ...(deps.autoResumeOnUsageLimit !== undefined
      ? { autoResumeOnUsageLimit: deps.autoResumeOnUsageLimit }
      : {}),
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
    providerFactory: deps.providerFactory,
  }));
}

/**
 * Build the session context from CLI options. Throws with a user-facing
 * message when option parsing fails — caller is responsible for spinner
 * teardown and exit code.
 *
 * Side effects: constructs an SDK AgentSession (opens a subprocess),
 * registers slash commands, creates a non-terminal readline interface on
 * stdin/stdout. Does NOT register cleanup — the caller owns cleanup order
 * so teardown remains auditable in one place.
 */
export async function bootstrapSession(
  options: CliOptions,
  extras?: { cwd?: string },
): Promise<InteractiveCtx> {
  // Witness layer: capture true bootstrap entry time. The trace writer is
  // created a few lines below, so bootstrap_start (writer-ready marker) and
  // bootstrap_done (full span, measured from here) are emitted once it exists.
  const bootstrapStartedAt = Date.now();
  const resumeTarget = resolveResumeTarget(options);
  const resumeConfig = resumeConfigFor(resumeTarget);
  const sessionModel = resumeTarget?.stored?.model ?? options.model;
  // Fail fast on an unconfigured capability tier (e.g. `afk i -m local` with no
  // AFK_MODEL_LOCAL) before building the REPL session — an empty id would
  // otherwise reach the provider as an opaque error or a silent cloud call.
  const unconfiguredModel = unconfiguredSlotError(sessionModel);
  if (unconfiguredModel) {
    throw new Error(unconfiguredModel);
  }

  let thinking: ThinkingConfig | undefined;
  let effort: EffortLevel | undefined;
  let maxOutputTokens: number | undefined;
  thinking = parseThinking(options.thinking) ?? getThinking();
  effort = parseEffort(options.effort) ?? getEffort();
  maxOutputTokens = parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens();

  // System-prompt layering: the framework base (`prompts/system-prompt.md`)
  // is unconditional; the operator overlay (env → afk.config.json → AFK.md)
  // is appended on top via resolveBaseSystemPrompt(), never substituted for
  // the base. `source` is the layered provenance string surfaced by
  // --dump-prompt (`framework`, `framework+afk-md:/path`, …).
  const { prompt: basePrompt, source: systemPromptSource } = resolveBaseSystemPrompt();
  const cliConfig = loadConfig();
  const autoRouting = cliConfig.autoRouting?.interactive ?? true;
  const systemPrompt = assembleSystemPrompt(basePrompt, autoRouting, 'repl');

  // Wire Agent tool by creating SubagentExecutor first.
  // The executor needs the session's methods, so we use a deferred parent proxy
  // that reads through sessionRef so a mid-session swap is transparent to all
  // child executors without re-wiring.
  // sessionRef is populated after the session is constructed below.
  const sessionRef: SessionRef = { current: null! };

  const apiKey = getApiKey();
  const rootManager = new SubagentManager({
    apiKey,
    // Provider source of truth for the fork-time credential fallback: `apiKey`
    // is `getApiKey()`, which keys off `getModel()` (AFK_MODEL), so the parent
    // key's provider is `providerForModel(getModel())`. Passing that keeps the
    // fallback from crossing the provider boundary (see parentProvider).
    parentModel: getModel(),
    ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    // Propagate the worktree cwd (when `afk i --worktree` set it) into every
    // forked subagent so their tool handlers' resolveBase + readRoots anchor
    // to the worktree, not the Node host's process.cwd(). Without this,
    // subagents resolve relative paths like `src/foo.ts` against the parent
    // repo and the `read_file` handler returns parent-repo contents instead
    // of the worktree's. Mirrors `chat.ts:163` for the one-shot path.
    ...(extras?.cwd !== undefined ? { cwd: extras.cwd } : {}),
  });

  // Witness layer: open trace BEFORE the executor so the
  // BackgroundAgentRegistry can be constructed with the writer in hand.
  // The trace path is logged after `bootstrapSession` returns (caller-side
  // banner), so we open the file here but defer the log line until later
  // to preserve startup-message ordering.
  const traceSessionLabel = resumeTarget?.stored?.sessionId;
  const trace = createDefaultTraceWriter(
    traceSessionLabel ? { sessionLabel: traceSessionLabel } : {},
  );
  // Witness layer: trace writer is now live — emit the bootstrap_start marker.
  // (Total bootstrap span is reported by bootstrap_done, measured from the
  // function-entry timestamp captured above.)
  void emitSessionPhase(trace?.writer, { phase: 'bootstrap_start' });

  // BackgroundAgentRegistry — owns the lifecycle of every job spawned by
  // `agent` tool with mode="background". Constructed before the executor
  // so we can pass it via SubagentExecutorContext. Cancel-all is invoked
  // by the interactive teardown path so detached jobs do not outlive
  // their parent process.
  const backgroundRegistry = new BackgroundAgentRegistry(
    trace ? { traceWriter: trace.writer } : {},
  );
  setBgsubRegistry(backgroundRegistry);

  // Opt-in background summarizer — only constructed when bgSummaries: true.
  const bgSummariesEnabled = cliConfig.bgSummaries === true;
  const bgSummarizer = bgSummariesEnabled && apiKey
    ? new BackgroundSummarizer({
        registry: backgroundRegistry,
        apiKey,
        maxCallsPerSession: cliConfig.maxSummaryCallsPerSession ?? 200,
      })
    : undefined;
  bgSummarizer?.start();
  setBgsubSummarizer(bgSummarizer);

  // Pass openaiBaseUrl so OpenAI-routed children point at the configured
  // local shim (mlx_lm.server, Ollama, vLLM, llama.cpp, LM Studio) instead
  // of api.openai.com. The factory itself routes per-call between
  // AnthropicDirect / OpenAICompatible by `providerForModel(model)`.
  const childProviderFactory = createChildProviderFactory(
    cliConfig.openaiBaseUrl !== undefined
      ? { openaiBaseUrl: cliConfig.openaiBaseUrl }
      : {},
  );

  // External constraint: deferredParent reads through sessionRef.current so
  // a mid-session swap (mutating sessionRef.current) is transparent to all
  // child executors — they hold a reference to this proxy object, which
  // always delegates to the currently-active session.
  const deferredParent = {
    get sessionId() { return sessionRef.current?.sessionId; },
    getInputStreamRef() { return sessionRef.current?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() {
      return sessionRef.current?.abortSignal ?? new AbortController().signal;
    },
    // Expose the live session's registry so forked subagents resolve it via
    // SubagentManager.forkSubagent's parent fallback — the production path for
    // SubagentStart/Stop (incl. the shadow-verify nudge) and child-config
    // inheritance. The registry is constructed after this proxy, so reading
    // it lazily through sessionRef.current is required.
    get hookRegistry() { return sessionRef.current?.hookRegistry; },
  };

  // Shared child-skill-executor factory — both SubagentExecutor and
  // SkillExecutor need it for plugin skill children to nest properly.
  // See skill-executor.ts:buildForkedChildConfig for the wiring rationale.
  // traceWriter propagates so depth>0 skill forks remain visible in the
  // witness trace (otherwise nested skill→skill chains go invisible after
  // the first hop).
  // backgroundRegistry propagates so a plugin/registry skill whose subagent
  // calls `agent` with `mode:"background"` (the SKILL.md "Dispatch N
  // sub-agents in parallel" idiom) reaches the registry through every
  // depth — root → skill-forked child → skill-forked grandchild. Without
  // this, the dispatch fast-fails with a 163-byte "BackgroundAgentRegistry
  // is not wired" error after ~24ms (no model call).
  const childSkillExecutorFactory = createChildSkillExecutorFactory(
    sessionModel,
    apiKey,
    childProviderFactory,
    cliConfig.baseUrl,
    trace?.writer,
    backgroundRegistry,
    // Worktree cwd propagates into every depth of the skill-executor chain
    // (grandchild SkillExecutor → its per-call SubagentManager → forked
    // subagent config). Without this, depth ≥ 1 skill children silently
    // lose worktree isolation.
    extras?.cwd,
    // Per-model credential resolver: resolves credentials by child model
    // rather than forwarding the parent's captured apiKey — fixes Anthropic
    // children starving when the main model is OpenAI-routed.
    getApiKeyForModel,
    // Surface: REPL skill executor children inherit origin 'cli'.
    'cli',
    // Resolved default-subagent model threaded into nested skill executors so
    // skill→skill / skill→agent chains inherit the SAME policy as the top-level
    // executors below — closing the leak where a nested subagent silently
    // defaulted to Anthropic `sonnet` under an OpenAI-routed parent.
    getDefaultSubagentModel(sessionModel),
  );

  // Pass `sessionModel` to `getDefaultSubagentModel` so OpenAI-routed
  // parents (gpt-*, o*, codex-*, HF-style `org/model`) default to the
  // parent model for dispatched subagents — preventing the legacy
  // `'sonnet'` literal from silently routing local-only sessions to
  // api.anthropic.com. Claude parents still default to 'sonnet'.
  const subagentExecutor = new SubagentExecutor({
    subagentManager: rootManager,
    parentSession: deferredParent,
    // Session origin for routing-decision telemetry (REPL → cli).
    surface: 'cli',
    defaultConfig: {
      apiKey,
      systemPrompt: basePrompt,
      ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    },
    defaultSubagentModel: getDefaultSubagentModel(sessionModel),
    childProviderFactory,
    childSkillExecutorFactory,
    backgroundRegistry,
    // Per-model credential resolver: resolves credentials by child model
    // at fork time — fixes Anthropic children starving when main is OpenAI.
    resolveApiKeyForModel: getApiKeyForModel,
    // Top-level CLI wiring → explicit depth 0. See SubagentExecutorContext.depth
    // jsdoc for why this is required rather than defaulted.
    depth: 0,
    // Worktree isolation for depth ≥ 2 `agent` dispatch — `rootManager`
    // already carries cwd for depth-1, but the per-call childManager
    // constructed inside SubagentExecutor.execute() needs cwd too.
    ...(extras?.cwd !== undefined ? { cwd: extras.cwd } : {}),
  });

  const skillExecutor = new SkillExecutor({
    parentSession: deferredParent,
    // Session origin for skill-invocation + routing telemetry (REPL → cli).
    surface: 'cli',
    defaultModel: sessionModel,
    defaultSubagentModel: getDefaultSubagentModel(sessionModel),
    apiKey,
    childProviderFactory,
    childSkillExecutorFactory,
    // Background dispatch: a plugin skill's subagent calling `agent` with
    // `mode:"background"` is the SKILL.md "Dispatch N sub-agents in parallel"
    // idiom — `/research`, `/diagnose`, `/shadow-verify`, etc. The registry
    // must be forwarded into every SubagentExecutor in the chain (root
    // executor → forked child → forked grandchild) via
    // SkillExecutorContext.backgroundRegistry → buildForkedChildConfig.
    // Sibling to the SubagentExecutor wiring above.
    backgroundRegistry,
    ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    // Per-model credential resolver — mirrors SubagentExecutor wiring above.
    resolveApiKeyForModel: getApiKeyForModel,
    // Witness layer: without this, skill-forked subagents (every /review,
    // /diagnose, /shadow-verify, etc.) emit zero trace events, making
    // subagent failures undebuggable from disk.
    ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
    // Worktree isolation: skills invoked via the `skill` tool spawn their
    // subagents through a per-call SubagentManager constructed inside the
    // executor. Without forwarding cwd here, every `/diagnose`, `/mint`,
    // etc. runs its first-tier subagents against the host repo even when
    // `--worktree` was set.
    ...(extras?.cwd !== undefined ? { cwd: extras.cwd } : {}),
  });

  // Pass the raw base prompt (pre-assembly) so compose subagents do not
  // inherit ROUTING_DIRECTIVE or TOOL_SYSTEM_PROMPT — keeping them as
  // task workers that cannot spawn nested DAGs or recurse into skills.
  // Mirrors the SubagentExecutor defaultConfig.systemPrompt convention.
  const composeExecutor = new ComposeExecutor({
    parentSession: deferredParent,
    defaultModel: sessionModel,
    defaultSubagentModel: getDefaultSubagentModel(sessionModel),
    apiKey,
    // Per-model credential resolver — mirrors #640 for the compose fork-path.
    resolveApiKeyForModel: getApiKeyForModel,
    ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    // Anchor DAG nodes to the worktree (re-anchored via composeExecutor.setCwd).
    ...(extras?.cwd !== undefined ? { cwd: extras.cwd } : {}),
    systemPrompt: basePrompt ?? '',
    // Session identity for routing-decision rows (REPL → cli).
    surface: 'cli',
    depth: 0,
  });

  const sharedMemoryStore = new MemoryStore();

  // MCP — load `~/.afk/config/mcp.json` and connect every enabled server
  // BEFORE provider construction so the provider sees the MCP-bridged
  // tools in its initial schema set. The manager is also persisted on
  // `InteractiveCtx` so `interactive.ts` can call `disconnectAll()` during
  // teardown (ordered: subagents → session → mcpManager → memory → worktree).
  //
  // Failure model: `loadMcpConfig()` returns warnings, never throws. The
  // manager itself throws when an `alwaysLoad: true` server fails or when
  // there's a wire-name collision — both are user-facing config errors and
  // should abort bootstrap with the error message intact.
  let mcpManager: McpManager | undefined;
  {
    // Use the worktree cwd for project-local `.mcp.json` resolution so each
    // worktree can carry its own MCP config (matching how the worktree
    // already isolates everything else under `worktreeCwd`).
    const projectCwd = extras?.cwd ?? process.cwd();
    // Imported MCP servers from trusted source binaries (`importFrom`). Only
    // JSON-format configs (Claude Code) are loadable today; they enter as the
    // lowest-priority layer so AFK's own config always wins. MCP import is
    // off by default even for a trusted binary (it auto-runs commands on
    // connect) — this only fires when the user set `mcp: true` for a binary.
    const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
      .mcpConfigs.filter((c) => c.format === 'json')
      .map((c) => c.source);
    const loaded = loadMcpConfig({
      cwd: projectCwd,
      ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
      ...(options.mcpConfig !== undefined ? { cliOverride: options.mcpConfig } : {}),
    });
    const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;
    if (enabledCount > 0) {
      const sourcesLabel = loaded.sources.length === 1
        ? loaded.sources[0]
        : `${loaded.sources.length} source(s)`;
      console.log(palette.dim(`  mcp: ${enabledCount} server(s) from ${sourcesLabel ?? getMcpConfigPath()}`));
      // Witness layer: bracket the whole-fleet MCP connect. try/finally so
      // mcp_connect_done fires even when an alwaysLoad server makes fromConfig
      // throw. Per-server mcp_server_* pairs are emitted inside fromConfig via
      // the traceWriter passed below. Fire-and-forget; never gates connect.
      const mcpStartedAt = Date.now();
      void emitSessionPhase(trace?.writer, {
        phase: 'mcp_connect_start',
        metadata: { serverCount: enabledCount },
      });
      try {
        mcpManager = await McpManager.fromConfig(loaded.mcpServers, {
          warnings: loaded.warnings,
          ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
        });
      } finally {
        void emitSessionPhase(trace?.writer, {
          phase: 'mcp_connect_done',
          durationMs: Date.now() - mcpStartedAt,
          metadata: { serverCount: enabledCount },
        });
      }
    } else if (loaded.warnings.length > 0) {
      // Surface warnings even when no servers ended up enabled.
      for (const w of loaded.warnings) console.warn(`[mcp] ${w}`);
    }
  }

  // Build a fully-wired provider factory that the ProviderRouter calls to
  // resolve the active provider — at session init and again on each cross-family
  // /model swap (NOT every turn; the router reuses the active inner across turns
  // of the same family). The builder closes over the executors, memoryStore,
  // mcpManager, and openaiBaseUrl captured above so every provider it builds
  // (regardless of family) carries the full tool surface — agent/skill/compose
  // tools, MCP bridges, and the shared MemoryStore. This is what allows
  // mid-session /model cross-family switches (e.g. Claude → GPT) without losing
  // any tool wiring.
  //
  // When --provider is explicit (options.provider is set), parseProvider returns
  // a single fixed provider, so the builder always yields the same family. This
  // preserves the AFK_PROVIDER / --provider escape-hatch behavior.
  //
  // The MCP tool wire names are stable for the manager lifetime, so they can be
  // captured once in the closure without re-querying on every build.
  const mcpToolWireNames = mcpManager?.getMcpToolWireNames() ?? [];
  const buildProvider = (model: string | undefined): ModelProvider =>
    parseProvider(options.provider, {
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore: sharedMemoryStore,
      model: model !== undefined ? model : String(sessionModel),
      ...(cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : {}),
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    })
    ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: topLevelSurfaceAllowedTools(mcpToolWireNames),
      },
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore: sharedMemoryStore,
      surface: 'cli',
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    });

  // Memoize by provider family so the `startupProvider` built below for /allow-dir
  // wiring is the SAME instance the router's buildInner reuses for turn 1.
  // Without this, the two call sites mint separate instances with independent
  // read/write grant roots, and /allow-dir grants are silently dropped (they land
  // on the startup instance, never on the query runner). The cache key mirrors
  // parseProvider's own routing: the --provider override first (a fixed family),
  // otherwise providerForModel with the same openaiBaseUrl hint — so a key never
  // aliases two different provider families.
  const providerFactory = createMemoizedProviderFactory(buildProvider, (model) =>
    options.provider ??
    providerForModel(
      model !== undefined ? model : String(sessionModel),
      cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : undefined,
    ),
  );

  // Build the startup provider (for /allow-dir wiring below). Because the factory
  // memoizes by family, this returns the SAME instance the router reuses for
  // turn 1, so grants added via setAllowDirDispatcher reach the query runner.
  const startupProvider = providerFactory(String(sessionModel));

  // Create stats before session so the plan-mode gate getter can close over it.
  const stats = createSessionStats(sessionModel);
  if (resumeTarget?.stored) {
    reseedStatsFromStored(stats, resumeTarget.stored, resumeTarget.resumeId);
  }
  // Initial permission mode: --dangerously-skip-permissions wins, else the
  // resolved afk.config.json `permissionMode` (loadConfig now always returns one
  // — DEFAULT_CLI_PERMISSION_MODE = bypass for new installs, overridable by the
  // config key). Stamped on stats so the status-line badge + the plan/AFK/bypass
  // gate getters reflect it from turn 1; the session is constructed with the same
  // value via sharedDeps. The `!== undefined` guard is retained defensively.
  const initialPermissionMode = options.dangerouslySkipPermissions
    ? ('bypassPermissions' as const)
    : cliConfig.permissionMode;
  if (initialPermissionMode !== undefined) {
    stats.permissionMode = initialPermissionMode;
  }
  // Stamp the effective working directory on stats so the status line can
  // render it. We capture the same cwd the provider will see: the explicit
  // `extras.cwd` override (e.g. from `--worktree`) when present, else
  // `process.cwd()`. Captured once at bootstrap — sessions don't `chdir`
  // mid-run, and the status line treats this as a fixed identity field.
  stats.cwd = extras?.cwd ?? process.cwd();

  // Trace was opened earlier (before the executor) so the
  // BackgroundAgentRegistry could be constructed with the writer. Surface
  // the path here so the startup banner ordering is preserved.
  if (trace) {
    console.log(palette.dim(`  trace: ${trace.tracePath}`));
  }

  // Both slots default to `console.log` here; `runReplLoop` mutates them
  // after `armCompositor` resolves (when a borrowed compositor is available)
  // so between-turn slash output commits above the live overlay instead of
  // overlaying onto the input row. See CompletionWriter docs in shared.ts.
  const completionWriter: CompletionWriter = {
    fn: (line) => console.log(line),
    idleFn: (line) => console.log(line),
  };
  // Construct StatusLine BEFORE createReplRenderer so the renderer can route
  // its inter-turn raw writes through statusLine.withFullScrollRegion(...) —
  // see repl-renderer.ts for the DECSTBM sub-region scroll-loss contract this
  // wiring is defending against.
  const statusLine = new StatusLine();
  const replRenderer = createReplRenderer(process.stdout, { statusLine });

  // Stable hookRegistry shared across sessions (including swaps).
  // The hook callbacks close over `stats` and `completionWriter` which are
  // also stable, so the new session gets the same routing without re-wiring.
  // `pathApprovalGrantRef` is populated below once the provider exists; the
  // path-approval hook fails open until then (mirroring `setAllowDirDispatcher`
  // wiring order).
  const hookRegistryBundle = createDefaultHookRegistry(
    (info) => { completionWriter.fn(formatSubagentCompletion(info)); },
    'cli',
    sharedMemoryStore,
    () => stats.permissionMode,
    loadHooksConfig({ cwd: extras?.cwd }),
    { cwd: extras?.cwd, ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}) },
    () => extras?.cwd ?? process.cwd(),
  );
  const hookRegistry = hookRegistryBundle.registry;
  const pathApprovalGrantRef = hookRegistryBundle.pathApprovalGrantRef;

  // Capture deps needed by both the initial build and the swap closure.
  const sharedDeps: BuildAgentSessionDeps = {
    model: sessionModel,
    resumeConfig,
    systemPrompt,
    systemPromptSource,
    thinking,
    effort,
    maxOutputTokens,
    ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    providerFactory,
    hookRegistry,
    traceWriter: trace?.writer,
    cwd: extras?.cwd,
    maxTurns: parseInt(options.maxTurns, 10),
    autoResumeOnUsageLimit: cliConfig.autoResumeOnUsageLimit,
    ...(initialPermissionMode !== undefined ? { permissionMode: initialPermissionMode } : {}),
  };

  // Import any plugin JS entrypoints (manifest `main`) before constructing the
  // session: the skill manifest is assembled synchronously in the constructor,
  // so a plugin's registerSkill() side-effects must already have run for its
  // code-backed skills to appear. Idempotent + non-fatal; no-op without plugins.
  await ensurePluginEntrypointsLoaded();

  const session = buildAgentSession(sharedDeps);
  // Populate sessionRef (declared above deferredParent so the proxy works).
  sessionRef.current = session;

  // Witness layer: wire the subagent-success rollup so the rootManager's
  // foreground forks accumulate token/cost data into the parent session's
  // session_sealed payload. Late-bound here because session is constructed
  // after rootManager to avoid a circular reference.
  //
  // Read through `sessionRef.current` (not the closed-over `session`) so a
  // mid-session `/resume` swap — which rebinds `sessionRef.current` to a
  // freshly built AgentSession via performResumeSwap — routes subsequent
  // subagent completions into the live session's accumulators. Closing over
  // `session` would silently strand post-resume rollups on the old, discarded
  // session, dropping them from the active session's session_sealed payload.
  rootManager.setOnSubagentSucceeded((usage, costUsd) => {
    sessionRef.current?.recordSubagentCompletion(usage, costUsd);
  });

  const trustedSkillLedger = new TrustedSkillLedger();
  // Slash-command writer routes through `completionWriter` so when Stage 3's
  // persistent compositor swaps `completionWriter.fn` to `compositor.commitAbove`
  // between turns (it currently only swaps mid-turn — see turn-handler.ts:124),
  // slash output commits above the live overlay instead of tearing it. No
  // behavior change today: completionWriter.fn === console.log when slash
  // commands run (always between turns under the current arm/disarm cycle).
  const writer = createConsoleWriter(completionWriter);
  // ContextSampler constructor assigns `session` as the source.  attach() is
  // called by performResumeSwap (resume-swap.ts step 8) on every mid-session
  // swap to rebind the source and reset the cache; no call needed here.
  const contextSampler = new ContextSampler(session);
  // GitStatusSampler resolves the current branch (fast, local) + open PR
  // (network, detached) for the status line. Bound to the session's effective
  // cwd — under `--worktree` that differs from process.cwd(). Construction is
  // side-effect-free (no process spawn): the initial sample + the on-update
  // repaint wiring are kicked by setupSurface (REPL Phase 1), so bootstrap-only
  // unit tests never shell out to git/gh.
  const gitStatusSampler = new GitStatusSampler({
    cwd: stats.cwd ?? process.cwd(),
    // Suppress the per-turn git subprocess if the branch was checked < 1 s
    // ago — human turns are seconds apart so this is imperceptible, and it
    // bounds overhead on slow filesystems (network mounts, Docker volumes).
    branchTtlMs: 1_000,
  });

  const slashCtx: SlashContext = {
    session: sessionRef,
    stats,
    out: writer,
    ui: {
      clearScreen: () => {
        // Ordered-operation invariant: reset the persistent compositor's
        // overlay AND committed band BEFORE the physical clear. At idle the
        // overlay still holds the prior turn's composed slots (stage-rail /
        // progress-banner / live-thinking) because borrow-dispose re-composes
        // via overlayComposer.flush() rather than setOverlay('') (see
        // stream-renderer.ts), and the committed band still retains the prior
        // turn's last above-frame block. Without zeroing both here, the
        // post-clear repaint re-paints stale overlay/band rows onto the
        // freshly-cleared screen — the band leak resurrects the prior
        // transcript when a slash menu opens then collapses (a shrink repaint
        // firing repositionCommittedBand). getCompositor is wired by
        // repl-loop.ts after armCompositor and is reached late-bound at call
        // time; undefined on non-TTY surfaces (daemon/tests) → no-op.
        // setOverlay('') early-returns when the overlay is already empty.
        const compositor = slashCtx.getCompositor?.();
        compositor?.setOverlay('');
        compositor?.resetCommittedBand();
        statusLine.stop();
        contextSampler.reset();
        // CSI 3J clears scrollback, 2J clears viewport, H homes cursor.
        process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
        statusLine.start();
        // Read contextSampler at call time so any swap-replaced sampler is used.
        statusLine.repaint(formatStatusFields(stats, contextSampler, gitStatusSampler));
      },
      // Read contextSampler at call time (not at closure-capture time) so
      // a mid-session swap that calls contextSampler.attach(newSession) is
      // reflected on the next repaint.
      repaintStatusLine: () => statusLine.repaint(formatStatusFields(stats, contextSampler, gitStatusSampler)),
    },
    ledger: trustedSkillLedger,
    // Expose mcpManager so `/mcp auth complete` can call completeAuth().
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  };

  // requestResume delegates to performResumeSwap (resume-swap.ts).
  // The sharedDeps + model-precedence resolution lives here; the swap
  // sequence itself is tested independently via the exported function.
  const requestResume = (target: ResolvedResumeTarget) => {
    // Clear the trusted-skill ledger so the resumed session starts with a
    // clean slate. The ledger accumulates per-session run statistics
    // (displayed by /stats); entries from the outgoing session would
    // otherwise bleed into the new session's display. Mirrors the /clear
    // behaviour (core.ts) which also calls ledger.clear().
    trustedSkillLedger.clear();
    return performResumeSwap(target, {
      sessionRef,
      stats,
      contextSampler,
      gitStatusSampler,
      statusLine,
      backgroundRegistry,
      completionWriter,
      isInFlight: () => ctx.getInFlight?.() ?? false,
      onSwapped: (t) => {
        ctx.resumeTarget = t;
        // Reset the verdict ledger so the outgoing session's terminal-state
        // trajectory does not contaminate the resumed session. The ledger is
        // owned by repl-loop's closure; the setter is wired by runReplLoop
        // before /resume can fire. Optional — early /resume calls before
        // the ledger is wired are a no-op (safe).
        ctx.clearVerdictLedger?.();
        // Drop buffered background-subagent results from the outgoing
        // session — cancelAll ran at the swap commit point, but a job that
        // settled just before it may already sit in the notifier's buffer
        // and would otherwise inject into the resumed session's first turn.
        ctx.clearBgResultBuffer?.();
      },
      buildSession: (t) => buildAgentSession({
        ...sharedDeps,
        model: t.stored?.model ?? sharedDeps.model,
        resumeConfig: resumeConfigFor(t),
        // Preserve the LIVE permission mode across a model swap (e.g. the user
        // toggled /bypass after startup) rather than resetting to the initial
        // config value carried in sharedDeps.
        permissionMode: stats.permissionMode,
      }),
    });
  };

  // Build the ctx object first (so requestResume can close over it for
  // getInFlight and resumeTarget mutation), then wire requestResume in.
  const ctx: InteractiveCtx = {
    session: sessionRef,
    memoryStore: sharedMemoryStore,
    stats,
    statusLine,
    contextSampler,
    gitStatusSampler,
    completionWriter,
    replRenderer,
    slashCtx,
    rl: null!,  // overwritten below
    options,
    ...(resumeTarget !== undefined ? { resumeTarget } : {}),
    teardownTrustedSkillEvents: undefined,  // wired below
    backgroundRegistry,
    // Expose the root executor's narrow promotion seam so the turn handler can
    // make Ctrl+B background a running foreground subagent. The executor
    // implements `SubagentControl`; the keyboard layer sees only that interface.
    subagentControl: subagentExecutor,
    ...(bgSummarizer !== undefined ? { bgSummarizer } : {}),
    requestResume,
    // Default to false so any code path that reads getInFlight before
    // interactive.ts overrides it (e.g. an early /resume call triggered
    // in a firstTurnHook) does not accidentally see undefined and
    // misclassify the in-flight state.
    getInFlight: () => false,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    // Thread the resolved auth credentials into ctx so the ghost-text
    // suggest engine's getContext() closure uses the same token and
    // endpoint the AgentSession was constructed with. Captured once here
    // (session-stable values) to avoid per-keystroke loadConfig() I/O.
    // `apiKey` was resolved above by getApiKey() (line 149); `cliConfig`
    // was loaded above by loadConfig() (line 137).
    suggestApiKey: apiKey,
    // Mirror the main session's OpenAI-compatible endpoint: the suggest engine
    // forwards `suggestBaseUrl` as an `openaiBaseUrl` provider hint
    // (suggest.ts:355), and parseProvider above (line 352) wires the live
    // session from `cliConfig.openaiBaseUrl` — NOT `cliConfig.baseUrl` (that is
    // the distinct Anthropic-shim endpoint, config.ts:48 vs :59). Using
    // openaiBaseUrl here keeps side-channel completions on the same local/proxy
    // endpoint the session uses instead of falling back to api.openai.com.
    ...(cliConfig.openaiBaseUrl !== undefined ? { suggestBaseUrl: cliConfig.openaiBaseUrl } : {}),
    ...(cliConfig.interactive?.suggestGhost !== undefined
      ? { suggestGhostConfig: cliConfig.interactive.suggestGhost }
      : {}),
    hookRegistry: hookRegistryBundle.registry,
  };

  // Trusted-skill event subscriptions — emit in-flight + completion badges
  // inline at the invocation point via completionWriter (routed to
  // compositor.commitAbove during a live turn; falls back to console.log
  // outside a turn). Recorded in the ledger on completion. Each event is
  // its own scrollback line, so overlapping skills no longer need Set-based
  // tracking the way the status-line approach did.
  const onStart = (skillName: string) => {
    completionWriter.fn(
      formatTrustedSkillInFlight(skillName, {
        isTTY: process.stdout.isTTY,
        columns: process.stdout.columns,
      }),
    );
  };

  const onComplete = (result: TrustedSkillResult) => {
    completionWriter.fn(
      formatTrustedSkillCompletion(result, {
        isTTY: process.stdout.isTTY,
        columns: process.stdout.columns,
      }),
    );
    trustedSkillLedger.record(result);
  };

  onTrustedSkillStart(onStart);
  onTrustedSkillComplete(onComplete);
  ctx.teardownTrustedSkillEvents = () => {
    offTrustedSkillStart(onStart);
    offTrustedSkillComplete(onComplete);
  };

  registerAll();

  // Wire /allow-dir to the startup provider's grant API so the slash command
  // can mutate read/write roots across turns.
  //
  // Invariant: `startupProvider` MUST be the same instance the ProviderRouter
  // uses to run queries, or grants land on a dead instance and are silently
  // dropped. The per-family memoization in `providerFactory` above guarantees
  // this — the router's `buildInner` calls the same factory with a same-family
  // model and gets the cached instance back. Do not remove that cache without
  // rewiring this dispatcher to the router's active inner.
  //
  // We wire once here and do not rewire on /model swaps: directory grants are a
  // session-level concept (not per-model), and a Claude→GPT→Claude swap reuses
  // the cached instance with its grants intact. The duck-type guard (isGrantManager)
  // covers both AnthropicDirectProvider and OpenAICompatibleProvider — and any
  // future provider that exposes the GrantManager surface — without naming each.
  if (isGrantManager(startupProvider)) {
    setAllowDirDispatcher(startupProvider);
    // Wire the same provider into the path-approval + bash-restriction hooks so
    // they can mutate grants when the user picks Session / Always (persist) on
    // the elicitation prompt.
    pathApprovalGrantRef.current = startupProvider;
    // Seed read/write roots from persisted `persist` grants so the prompt's
    // "future sessions inherit it" promise actually holds. No-op when none.
    seedPersistedGrants(startupProvider);
  } else if (env.AFK_DISABLE_PATH_APPROVAL !== '1') {
    // Emit a one-time advisory when path-approval is enabled but the active
    // provider does not expose the GrantManager API. This makes fail-open
    // explicit rather than silent — the bash interpreter denylist still fires,
    // but the elicitation prompt and bash restricted-path check will not.
    // eslint-disable-next-line no-console
    console.warn(
      '[path-approval] active provider does not implement GrantManager — ' +
        'path-approval elicitation and bash restricted-path checks will not fire.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  ctx.rl = rl;

  // Late-bound InputSurface ref — populated by runReplLoop after armCompositor.
  // The elicitation handler closes over this so suspend/resume works at
  // invocation time even though the surface isn't armed yet at install time.
  const inputSurfaceRef: { current: import('../../input/input-surface.js').InputSurface | null } = { current: null };
  ctx.inputSurfaceRef = inputSurfaceRef;

  // Install the REPL elicitation handler so ask_question calls from the
  // agent are routed to the interactive readline surface.
  elicitationRouter.install(makeReplElicitationHandler({
    readLine: (prompt) => new Promise((resolve, reject) => {
      rl.question(prompt, resolve);
      rl.once('close', () => reject(new Error('readline closed')));
    }),
    writer: { line: (text = '') => process.stdout.write(text + '\n') },
    pendingCount: () => elicitationRouter.pendingCount(),
    suspendInput: () => inputSurfaceRef.current?.suspendForElicitation(),
    resumeInput: () => inputSurfaceRef.current?.resumeAfterElicitation(),
  }));

  // Wire requestResume into slashCtx so slash commands can call it.
  slashCtx.requestResume = requestResume;

  // Witness layer: bootstrap complete — emit the done marker with the full
  // span measured from function entry (covers config load, manager + writer
  // construction, MCP connect, provider + session build).
  void emitSessionPhase(trace?.writer, {
    phase: 'bootstrap_done',
    durationMs: Date.now() - bootstrapStartedAt,
  });

  return ctx;
}
