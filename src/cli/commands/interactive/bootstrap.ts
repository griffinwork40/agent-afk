import * as readline from 'node:readline';
import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import { AgentSession } from '../../../agent/session.js';
import { createDefaultHookRegistry } from '../../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory, MEMORY_TOOL_NAMES } from '../../../agent/memory/index.js';
import type { ThinkingConfig, EffortLevel } from '../../../agent/types.js';
import type { AgentConfig } from '../../../agent/types.js';
import type { ModelProvider } from '../../../agent/provider.js';
import type { HookRegistry } from '../../../agent/hooks.js';
import type { TraceWriter } from '../../../agent/trace/index.js';
import {
  parseThinking, parseEffort, parseMaxOutputTokens, parseProvider, getApiKey, getApiKeyForModel, getThinking, getEffort,
  getMaxOutputTokens, getDefaultSubagentModel, loadSystemPrompt, loadConfigSystemPrompt,
} from '../../shared-helpers.js';
import { loadConfig } from '../../config.js';
import { assembleSystemPrompt } from '../../../agent/routing-directive.js';
import { StatusLine } from '../../status-line.js';
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
import { BUILTIN_TOOL_NAMES } from '../../../agent/tools/schemas.js';
import { AWARENESS_TOOL_NAMES } from '../../../agent/awareness/index.js';
import { McpManager, loadMcpConfig, getMcpConfigPath } from '../../../agent/mcp/index.js';
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
  provider: ModelProvider;
  hookRegistry: HookRegistry;
  traceWriter: TraceWriter | undefined;
  cwd: string | undefined;
  maxTurns: number;
  autoResumeOnUsageLimit: boolean | undefined;
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
    apiKey: getApiKey(),
    maxTurns: deps.maxTurns,
    hookRegistry: deps.hookRegistry,
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
    provider: deps.provider,
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

  let thinking: ThinkingConfig | undefined;
  let effort: EffortLevel | undefined;
  let maxOutputTokens: number | undefined;
  thinking = parseThinking(options.thinking) ?? getThinking();
  effort = parseEffort(options.effort) ?? getEffort();
  maxOutputTokens = parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens();

  // Dual-path system-prompt resolution: `basePrompt` is sourced via
  // `loadConfigSystemPrompt`/`loadSystemPrompt` (string-only path), while
  // `systemPromptSource` provenance comes from `loadConfig()`. Both walk the
  // same 3-tier precedence (env → afk.config.json → AFK.md) in the same order,
  // so in production they agree. Any future caller that invokes one without
  // the other risks an orphaned source tag — keep them paired.
  const basePrompt = loadConfigSystemPrompt() ?? loadSystemPrompt();
  const cliConfig = loadConfig();
  const systemPromptSource = cliConfig.systemPromptSource;
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
  );

  // Pass `sessionModel` to `getDefaultSubagentModel` so OpenAI-routed
  // parents (gpt-*, o*, codex-*, HF-style `org/model`) default to the
  // parent model for dispatched subagents — preventing the legacy
  // `'sonnet'` literal from silently routing local-only sessions to
  // api.anthropic.com. Claude parents still default to 'sonnet'.
  const subagentExecutor = new SubagentExecutor({
    subagentManager: rootManager,
    parentSession: deferredParent,
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
    ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
    systemPrompt: basePrompt ?? '',
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
    const loaded = loadMcpConfig({
      cwd: projectCwd,
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

  // Pass sharedMemoryStore so that when --provider anthropic-direct is explicit
  // both paths share the same SQLite DB (C7: avoid dual MemoryStore instances).
  const provider = parseProvider(options.provider, {
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    memoryStore: sharedMemoryStore,
    model: String(sessionModel),
    ...(cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : {}),
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  })
    ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: [
          ...BUILTIN_TOOL_NAMES,
          ...MEMORY_TOOL_NAMES,
          ...AWARENESS_TOOL_NAMES,
          'agent',
          'skill',
          'compose',
          ...(mcpManager?.getMcpToolWireNames() ?? []),
        ],
      },
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore: sharedMemoryStore,
      surface: 'cli',
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    });

  // Create stats before session so the plan-mode gate getter can close over it.
  const stats = createSessionStats(sessionModel);
  if (resumeTarget?.stored) {
    reseedStatsFromStored(stats, resumeTarget.stored, resumeTarget.resumeId);
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
  const hookRegistry = createDefaultHookRegistry(
    (info) => { completionWriter.fn(formatSubagentCompletion(info)); },
    'cli',
    sharedMemoryStore,
    () => (stats.planMode ? 'plan' : 'default'),
    loadHooksConfig({ cwd: extras?.cwd }),
    { cwd: extras?.cwd },
  ).registry;

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
    provider,
    hookRegistry,
    traceWriter: trace?.writer,
    cwd: extras?.cwd,
    maxTurns: parseInt(options.maxTurns, 10),
    autoResumeOnUsageLimit: cliConfig.autoResumeOnUsageLimit,
  };

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
        statusLine.repaint(formatStatusFields(stats, contextSampler));
      },
      // Read contextSampler at call time (not at closure-capture time) so
      // a mid-session swap that calls contextSampler.attach(newSession) is
      // reflected on the next repaint.
      repaintStatusLine: () => statusLine.repaint(formatStatusFields(stats, contextSampler)),
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
      },
      buildSession: (t) => buildAgentSession({
        ...sharedDeps,
        model: t.stored?.model ?? sharedDeps.model,
        resumeConfig: resumeConfigFor(t),
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
    completionWriter,
    replRenderer,
    slashCtx,
    rl: null!,  // overwritten below
    options,
    ...(resumeTarget !== undefined ? { resumeTarget } : {}),
    teardownTrustedSkillEvents: undefined,  // wired below
    backgroundRegistry,
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

  // Wire /allow-dir to the provider's grant API so the slash command can
  // mutate read/write roots across turns. Only AnthropicDirectProvider
  // implements the GrantManager interface; other providers are no-ops.
  if (provider instanceof AnthropicDirectProvider) {
    setAllowDirDispatcher(provider);
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
