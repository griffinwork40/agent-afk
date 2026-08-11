import { MemoryStore } from '../../../agent/memory/index.js';
import type { SlashContext } from '../../slash/types.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { CliOptions, InteractiveCtx } from './shared.js';
import { ContextSampler } from '../../context-sampler.js';
import { ensurePluginEntrypointsLoaded } from '../../../agent/tools/skill-bridge.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import { emitSessionPhase } from '../../../agent/trace/emit.js';
import { performResumeSwap, resumeConfigFor } from './resume-swap.js';
import { resolveBootstrapConfig } from './bootstrap-config.js';
import { createBootstrapInfra } from './bootstrap-infra.js';
import { connectReplMcp } from './bootstrap-mcp.js';
import { createReplProviders } from './bootstrap-providers.js';
import { createReplSurface } from './bootstrap-surface.js';
import { createReplHookRegistry } from './bootstrap-hooks.js';
import { createReplSlashContext } from './bootstrap-slash-context.js';
import { wireTrustedSkillEvents, wireProviderGrants, createReplInput } from './bootstrap-wiring.js';
import { buildAgentSession, buildSharedDeps } from './bootstrap-session-builder.js';
import { registerAll } from '../../slash/index.js';

// Re-exported so `resume-swap.test.ts` (and the mid-session swap closure
// below) can resolve `buildAgentSession` from this module — the historical
// import path every existing caller uses.
export { buildAgentSession } from './bootstrap-session-builder.js';

/**
 * Build the session context from CLI options. Throws with a user-facing
 * message when option parsing fails — caller is responsible for spinner
 * teardown, exit code, and draining any `extras.bootWarnings` it supplied
 * (warnings pushed before the throw never reach the returned ctx).
 *
 * Side effects: constructs an SDK AgentSession (opens a subprocess),
 * registers slash commands, creates a non-terminal readline interface on
 * stdin/stdout. Does NOT register cleanup — the caller owns cleanup order
 * so teardown remains auditable in one place.
 */
export async function bootstrapSession(
  options: CliOptions,
  extras?: { cwd?: string; bootWarnings?: string[] },
): Promise<InteractiveCtx> {
  // Witness layer: capture true bootstrap entry time. The trace writer is
  // created a few lines below, so bootstrap_start (writer-ready marker) and
  // bootstrap_done (full span, measured from here) are emitted once it exists.
  const bootstrapStartedAt = Date.now();

  const {
    resumeTarget, resumeConfig, effectiveCwd, sessionModel,
    thinking, effort, maxOutputTokens, maxToolUseIterations,
    basePrompt, systemPrompt, systemPromptSource, cliConfig,
  } = resolveBootstrapConfig(options, extras);

  // Wire Agent tool by creating SubagentExecutor first.
  // The executor needs the session's methods, so we use a deferred parent proxy
  // that reads through sessionRef so a mid-session swap is transparent to all
  // child executors without re-wiring.
  // sessionRef is populated after the session is constructed below.
  const sessionRef: SessionRef = { current: null! };

  // Bootstrap warnings that must outlive the startup screen clear. Everything
  // written to stdout/stderr from here until `interactive.ts` finishes clearing
  // is destroyed — `\x1b[3J` erases scrollback, not just the viewport — so
  // producers accumulate into this bucket and `interactive.ts` drains it after
  // the clear. See `InteractiveCtx.bootWarnings` (#745).
  //
  // Adopted from the caller when supplied, because this function can throw
  // AFTER producers have pushed (`McpManager.fromConfig` below rejects for an
  // `alwaysLoad` server that fails to connect) and a thrown bootstrap returns
  // no ctx to drain — the warnings would be silently destroyed. The REPL passes
  // its own array so its catch block can still print them. Callers that don't
  // care get a local bucket and the prior behaviour.
  const bootWarnings: string[] = extras?.bootWarnings ?? [];

  const {
    trace, apiKey, backgroundRegistry, bgSummarizer,
    rootManager, subagentExecutor, skillExecutor, composeExecutor,
  } = createBootstrapInfra({
    sessionRef, options, cliConfig, sessionModel, basePrompt, effectiveCwd, resumeTarget, bootWarnings,
  });

  const sharedMemoryStore = new MemoryStore();
  const { FastModeController } = await import('../../../agent/fast-mode.js');
  const fastModeController = new FastModeController();

  // MCP — load `~/.afk/config/mcp.json` and connect every enabled server
  // BEFORE provider construction so the provider sees the MCP-bridged
  // tools in its initial schema set. The manager is also persisted on
  // `InteractiveCtx` so `interactive.ts` can call `disconnectAll()` during
  // teardown (ordered: subagents → session → mcpManager → memory → worktree).
  const mcpManager = await connectReplMcp({
    effectiveCwd,
    mcpConfigOverride: options.mcpConfig,
    traceWriter: trace?.writer,
    bootWarnings,
  });

  // Build a fully-wired provider factory that the ProviderRouter calls to
  // resolve the active provider. Must run AFTER MCP connect — the factory's
  // builder closes over `mcpManager`.
  const { providerFactory, startupProvider } = createReplProviders({
    options, cliConfig, sessionModel, subagentExecutor, skillExecutor, composeExecutor,
    memoryStore: sharedMemoryStore, mcpManager, fastModeController,
  });

  // Stats, permission/thinking-UI seeding, startup banners (`trace:` /
  // `↪ resuming in` — preserving the `mcp:` → `trace:` → `↪ resuming in`
  // console-output order), StatusLine/renderer/writer, trusted-skill ledger,
  // and git-status sampler.
  const {
    stats, initialPermissionMode, completionWriter, statusLine, replRenderer,
    writer, trustedSkillLedger, gitStatusSampler,
  } = createReplSurface({
    options, cliConfig, sessionModel, resumeTarget, effectiveCwd, extrasCwd: extras?.cwd, trace,
  });

  // Stable hookRegistry shared across sessions (including swaps), plus the
  // terminal-state Stop gate registered on top of it. `pathApprovalGrantRef`
  // is populated later (wireProviderGrants) once the provider exists.
  const { hookRegistry, pathApprovalGrantRef } = createReplHookRegistry({
    completionWriter, memoryStore: sharedMemoryStore, stats, effectiveCwd, traceWriter: trace?.writer,
  });

  // Capture deps needed by both the initial build and the swap closure.
  const sharedDeps = buildSharedDeps({
    sessionModel, resumeConfig, systemPrompt, systemPromptSource, thinking, effort,
    maxOutputTokens, maxToolUseIterations, cliConfig, providerFactory, hookRegistry,
    traceWriter: trace?.writer, effectiveCwd, maxTurns: options.maxTurns, initialPermissionMode,
    // Cascade-abort and drain in-flight children before the writer seals,
    // so a wave still running when this session ends emits real `cancelled`
    // rows instead of vanishing (#733).
    drainSubagents: (reason) =>
      rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
  });

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

  // ContextSampler constructor assigns `session` as the source.  attach() is
  // called by performResumeSwap (resume-swap.ts step 8) on every mid-session
  // swap to rebind the source and reset the cache; no call needed here.
  const contextSampler = new ContextSampler(session);

  const slashCtx: SlashContext = createReplSlashContext({
    sessionRef, stats, writer, statusLine, contextSampler, gitStatusSampler,
    ledger: trustedSkillLedger, mcpManager, fastModeController,
    ...(cliConfig.baseUrl !== undefined ? { anthropicBaseUrl: cliConfig.baseUrl } : {}),
    ...(cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : {}),
    ...(options.provider !== undefined ? { explicitProvider: options.provider } : {}),
  });

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
    // Same array the producers above pushed into — drained post-clear by
    // interactive.ts. Passed by reference so a late producer (anything between
    // here and `return ctx`) still lands.
    bootWarnings,
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
    hookRegistry,
  };

  // Trusted-skill event subscriptions — emit in-flight + completion badges
  // inline at the invocation point via completionWriter (routed to
  // compositor.commitAbove during a live turn; falls back to console.log
  // outside a turn). Recorded in the ledger on completion.
  ctx.teardownTrustedSkillEvents = wireTrustedSkillEvents(completionWriter, trustedSkillLedger);

  registerAll();

  // Wire /allow-dir to the startup provider's grant API so the slash command
  // can mutate read/write roots across turns. Must run AFTER registerAll()
  // (ordering hazard: the dispatcher setter is itself a slash-command module
  // side effect target) and reads `pathApprovalGrantRef` populated by the
  // hook bundle above.
  wireProviderGrants(startupProvider, pathApprovalGrantRef);

  const { rl, inputSurfaceRef } = createReplInput();
  ctx.rl = rl;
  ctx.inputSurfaceRef = inputSurfaceRef;

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
